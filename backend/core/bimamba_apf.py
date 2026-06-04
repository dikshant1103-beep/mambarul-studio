"""
bimamba_apf.py — BiMamba-Attention-Physics Fusion (v12)
Concept & design: Dikshant Patel, 2026

Architecture:
  Input (B, 30, 13)
    → ChemShapeEmbedding (chemistry + form-factor tokens)
    → MultiScaleCNN (ks=1,3,5 parallel branches)
    → 3× BiMambaBlock (forward + reverse SSM)
    → CrossChemAttention (cross-chemistry multi-head attention)
    → PhysicsGate (Arrhenius + monotonicity + cap-slope → sigmoid gate)
    → FeatureFusion (learnable weighted sum)
    → RUL head (MC Dropout → mean + std)
    → SOH head (Sigmoid → [0,1])

  forward()                → (rul_norm, soh)
  predict_with_uncertainty → (rul_mean, rul_std, soh)  [k=100 MC passes]

No existing classes modified. New file only.
"""
import torch
import torch.nn as nn
import torch.nn.functional as F


# ─────────────────────────────────────────────────────────────────
# MC Dropout — stays active during eval() for uncertainty sampling
# ─────────────────────────────────────────────────────────────────

class MCDropout(nn.Dropout):
    def forward(self, x):
        return F.dropout(x, self.p, training=True, inplace=self.inplace)


# ─────────────────────────────────────────────────────────────────
# BiMamba Block — bidirectional SSM
# ─────────────────────────────────────────────────────────────────

class BiMambaBlock(nn.Module):
    """
    Bidirectional Mamba: forward scan + reverse scan → concat → project.
    Reuses MambaBlock from mambarul_model (no modification).
    Reverse scan = flip sequence → forward pass → flip back.
    """
    def __init__(self, d_model=128, d_state=16, d_conv=4, expand=2, dropout=0.1):
        super().__init__()
        from core.mambarul_model import MambaBlock
        self.fwd  = MambaBlock(d_model, d_state, d_conv, expand, dropout)
        self.rev  = MambaBlock(d_model, d_state, d_conv, expand, dropout)
        self.proj = nn.Linear(d_model * 2, d_model, bias=False)
        self.norm = nn.LayerNorm(d_model)

    def forward(self, x):
        f   = self.fwd(x)
        r   = self.rev(torch.flip(x, dims=[1]))
        r   = torch.flip(r, dims=[1])
        out = self.proj(torch.cat([f, r], dim=-1))
        return self.norm(out)


# ─────────────────────────────────────────────────────────────────
# Chemistry + Shape Factor Embedding
# ─────────────────────────────────────────────────────────────────

class ChemShapeEmbedding(nn.Module):
    """
    Chemistry type (LCO/LFP/NMC/NCM/NCA) + cell form factor
    (Cylindrical/Pouch/Prismatic) → learned token added to every timestep.

    Shape codes: 0=Cylindrical, 1=Pouch, 2=Prismatic
    All current datasets (CALCE/HUST/MIT/Oxford/TJU) are Cylindrical → shape_code=0
    """
    def __init__(self, n_chem=5, n_shape=3, d_emb=32, d_model=128):
        super().__init__()
        self.chem_emb  = nn.Embedding(n_chem,  d_emb)
        self.shape_emb = nn.Embedding(n_shape, d_emb)
        self.proj      = nn.Linear(d_emb * 2, d_model)
        self.norm      = nn.LayerNorm(d_model)

    def forward(self, chem_code: torch.Tensor, shape_code: torch.Tensor, seq_len: int):
        c   = self.chem_emb(chem_code)                          # (B, d_emb)
        s   = self.shape_emb(shape_code)                        # (B, d_emb)
        tok = self.norm(self.proj(torch.cat([c, s], dim=-1)))   # (B, d_model)
        return tok.unsqueeze(1).expand(-1, seq_len, -1)         # (B, L, d_model)


# ─────────────────────────────────────────────────────────────────
# Multi-Scale CNN Block
# ─────────────────────────────────────────────────────────────────

class MultiScaleCNN(nn.Module):
    """
    Three parallel Conv1D branches (ks=1, ks=3, ks=5) capture local
    degradation patterns at different temporal scales.
    """
    def __init__(self, in_ch=13, d_model=128):
        super().__init__()
        mid = d_model // 3   # 42 channels each branch

        self.b1 = nn.Sequential(
            nn.Conv1d(in_ch, mid, 1, padding=0), nn.ReLU(),
            nn.Conv1d(mid,   mid, 1, padding=0), nn.ReLU())
        self.b3 = nn.Sequential(
            nn.Conv1d(in_ch, mid, 3, padding=1), nn.ReLU(),
            nn.Conv1d(mid,   mid, 3, padding=1), nn.ReLU())
        self.b5 = nn.Sequential(
            nn.Conv1d(in_ch, mid, 5, padding=2), nn.ReLU(),
            nn.Conv1d(mid,   mid, 5, padding=2), nn.ReLU())

        self.fuse = nn.Sequential(
            nn.Linear(mid * 3, d_model),
            nn.LayerNorm(d_model))

    def forward(self, x):
        xt = x.transpose(1, 2)                                  # (B, C, L)
        b1 = self.b1(xt).transpose(1, 2)                        # (B, L, mid)
        b3 = self.b3(xt).transpose(1, 2)
        b5 = self.b5(xt).transpose(1, 2)
        return self.fuse(torch.cat([b1, b3, b5], dim=-1))       # (B, L, d_model)


# ─────────────────────────────────────────────────────────────────
# Cross-Chemistry Attention
# ─────────────────────────────────────────────────────────────────

class CrossChemAttention(nn.Module):
    """
    Multi-head cross-attention: query=BiMamba output, key/value=learned
    chemistry tokens. Model learns which chemistry patterns are relevant
    for each timestep. Attention weights are interpretable per-chemistry.
    """
    def __init__(self, d_model=128, n_heads=4, n_chem=5, dropout=0.1):
        super().__init__()
        self.chem_tokens = nn.Parameter(torch.randn(1, n_chem, d_model) * 0.02)
        self.attn = nn.MultiheadAttention(
            d_model, n_heads, dropout=dropout, batch_first=True)
        self.norm = nn.LayerNorm(d_model)

    def forward(self, x):
        B      = x.shape[0]
        kv     = self.chem_tokens.expand(B, -1, -1)    # (B, n_chem, d_model)
        out, _ = self.attn(x, kv, kv)
        return self.norm(x + out)


# ─────────────────────────────────────────────────────────────────
# Physics Gate
# ─────────────────────────────────────────────────────────────────

class PhysicsGate(nn.Module):
    """
    Extracts 3 physics scores from raw input features:
      1. Arrhenius factor  — col 5 (already transformed in normalized input)
      2. Monotonicity violation — capacity should only decrease
      3. Capacity fade slope  — linear fit over window

    Scores → MLP → Sigmoid → element-wise gate on feature map.
    Physics constraint loss (monotonicity) available for training.
    """
    def __init__(self, d_model=128):
        super().__init__()
        self.gate_mlp = nn.Sequential(
            nn.Linear(3, 32), nn.ReLU(),
            nn.Linear(32, d_model), nn.Sigmoid())

    def _scores(self, x: torch.Tensor) -> torch.Tensor:
        # x: (B, L, 13) normalized features
        cap  = x[:, :, 0]                                       # capacity col
        L    = cap.shape[1]

        # Score 1: mean Arrhenius factor in window
        arrh = x[:, :, 5].mean(dim=1, keepdim=True)            # (B, 1)

        # Score 2: monotonicity violation (capacity increase = non-physical)
        mono = F.relu(cap[:, 1:] - cap[:, :-1]).mean(dim=1, keepdim=True)  # (B, 1)

        # Score 3: capacity fade slope (closed-form linear fit)
        t    = torch.linspace(0, 1, L, device=x.device).unsqueeze(0)  # (1, L)
        tm   = t.mean()
        cm   = cap.mean(dim=1, keepdim=True)
        num  = ((t - tm) * (cap - cm)).sum(dim=1, keepdim=True)
        den  = ((t - tm) ** 2).sum() + 1e-8
        slope = num / den                                       # (B, 1)

        return torch.cat([arrh, mono, slope], dim=-1)           # (B, 3)

    def forward(self, x: torch.Tensor, x_raw: torch.Tensor) -> torch.Tensor:
        scores = self._scores(x_raw)                            # (B, 3)
        gate   = self.gate_mlp(scores)                          # (B, d_model)
        return x * gate.unsqueeze(1)                            # (B, L, d_model)

    def constraint_loss(self, x_raw: torch.Tensor) -> torch.Tensor:
        cap  = x_raw[:, :, 0]
        return F.relu(cap[:, 1:] - cap[:, :-1]).mean()


# ─────────────────────────────────────────────────────────────────
# Feature Fusion
# ─────────────────────────────────────────────────────────────────

class FeatureFusion(nn.Module):
    """
    Learnable softmax-weighted sum of BiMamba + CrossAttn + Physics streams.
    CNN output added as residual. LayerNorm applied after.
    """
    def __init__(self, d_model=128):
        super().__init__()
        self.w    = nn.Parameter(torch.ones(3))
        self.norm = nn.LayerNorm(d_model)

    def forward(self, cnn_out, bimamba_out, crossattn_out, physics_out):
        w = torch.softmax(self.w, dim=0)
        fused = w[0] * bimamba_out + w[1] * crossattn_out + w[2] * physics_out
        return self.norm(fused + cnn_out)


# ─────────────────────────────────────────────────────────────────
# BiMambaAPF — top-level v12 model
# ─────────────────────────────────────────────────────────────────

class BiMambaAPF(nn.Module):
    """
    v12: BiMamba-Attention-Physics Fusion.
    Concept: Dikshant Patel, 2026.

    Key improvements over v11-twohead:
    - Bidirectional Mamba (forward + reverse)
    - Multi-scale CNN for local feature extraction
    - Chemistry + shape factor token embedding
    - Cross-chemistry attention (interpretable per-chemistry weights)
    - Physics gate (Arrhenius + monotonicity + capacity slope)
    - MC Dropout → RUL distribution (mean + std), not point estimate
    - Per-chemistry normalization in training → no LFP blowup

    forward(x, chem_code, shape_code) → (rul_norm, soh)
    predict_with_uncertainty(x, ..., k=100) → (rul_mean, rul_std, soh)
    """
    def __init__(self, n_features=13, d_model=128, n_bimamba=3,
                 d_state=16, d_conv=4, expand=2, n_chem=5, n_shape=3,
                 n_heads=4, dropout=0.1):
        super().__init__()
        self.d_model = d_model

        self.input_proj = nn.Sequential(
            nn.Linear(n_features, d_model),
            nn.LayerNorm(d_model))

        self.chem_emb = ChemShapeEmbedding(n_chem, n_shape, d_emb=32, d_model=d_model)

        self.cnn = MultiScaleCNN(in_ch=n_features, d_model=d_model)

        self.bimamba_blocks = nn.ModuleList([
            BiMambaBlock(d_model, d_state, d_conv, expand, dropout)
            for _ in range(n_bimamba)])

        self.cross_chem  = CrossChemAttention(d_model, n_heads, n_chem, dropout)
        self.physics_gate = PhysicsGate(d_model)
        self.fusion      = FeatureFusion(d_model)

        self.rul_head = nn.Sequential(
            nn.Linear(d_model, 64), nn.GELU(),
            MCDropout(p=dropout),
            nn.Linear(64, 1))

        self.soh_head = nn.Sequential(
            nn.Linear(d_model, 64), nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(64, 1), nn.Sigmoid())

    def _make_codes(self, B, device, chem_code=None, shape_code=None):
        if chem_code is None or not isinstance(chem_code, torch.Tensor):
            val = int(chem_code) if chem_code is not None else 0
            chem_code = torch.full((B,), val, dtype=torch.long, device=device)
        if shape_code is None or not isinstance(shape_code, torch.Tensor):
            val = int(shape_code) if shape_code is not None else 0
            shape_code = torch.full((B,), val, dtype=torch.long, device=device)
        return chem_code, shape_code

    def forward_features(self, x, chem_code=None, shape_code=None):
        B, L, _ = x.shape
        chem_code, shape_code = self._make_codes(B, x.device, chem_code, shape_code)

        cnn_out = self.cnn(x)                                   # (B, L, d_model)

        h = self.input_proj(x)                                  # (B, L, d_model)
        h = h + self.chem_emb(chem_code, shape_code, L)

        for block in self.bimamba_blocks:
            h = block(h)
        bimamba_out = h

        crossattn_out = self.cross_chem(bimamba_out)
        physics_out   = self.physics_gate(bimamba_out, x)

        fused = self.fusion(cnn_out, bimamba_out, crossattn_out, physics_out)
        return fused.mean(dim=1)                                # (B, d_model)

    def forward(self, x, chem_code=None, shape_code=None):
        h   = self.forward_features(x, chem_code, shape_code)
        rul = self.rul_head(h).squeeze(-1)
        soh = self.soh_head(h).squeeze(-1)
        return rul, soh

    def forward_with_internal_states(self, x, chem_code=None, shape_code=None):
        """Phase C: return RUL + SOH + the internal-state vector. Requires an
        `internal_state_head` to have been attached via `attach_internal_state_head`."""
        if getattr(self, "internal_state_head", None) is None:
            raise RuntimeError(
                "internal_state_head is not attached; call attach_internal_state_head() first"
            )
        h   = self.forward_features(x, chem_code, shape_code)
        rul = self.rul_head(h).squeeze(-1)
        soh = self.soh_head(h).squeeze(-1)
        internal = self.internal_state_head(h)
        return rul, soh, internal

    def predict_with_uncertainty(self, x, chem_code=None, shape_code=None, k=100):
        """Run k MC Dropout passes → RUL mean + std + SOH."""
        was_training = self.training
        self.train()
        ruls = []
        with torch.no_grad():
            for _ in range(k):
                rul, soh = self.forward(x, chem_code, shape_code)
                ruls.append(rul)
        if not was_training:
            self.eval()
        ruls_t = torch.stack(ruls, dim=0)   # (k, B)
        return ruls_t.mean(dim=0), ruls_t.std(dim=0), soh

    def physics_loss(self, x):
        return self.physics_gate.constraint_loss(x)


# ── Phase C: Auxiliary internal-state estimator head ──────────────────────────

class InternalStateHead(nn.Module):
    """Multi-task auxiliary head predicting the 13-key internal-state vector
    (see core.internal_states.INTERNAL_STATE_KEYS). Consumes the (B, d_model)
    pooled latent from `BiMambaAPF.forward_features` and emits one scalar per
    internal observable. Trained with MSE against labels extracted via
    `core.internal_states.extract_internal_states` over the digital-twin fit
    of each cell — the supervised path for the publishable reverse-estimation
    of hidden electrochemistry from external BMS signals.
    """
    N_STATES = 13   # k_sei, k_crack, alpha, Q0, sei_thickness_nm, lli_fraction,
                    # lam_fraction, ir_growth_pct, cycles_to_eol, temp_stress_index,
                    # lithium_plating_risk, fit_r2, fit_mape  (see INTERNAL_STATE_KEYS)

    def __init__(self, d_model: int = 128, dropout: float = 0.1,
                 d_spectral: int = 0):
        super().__init__()
        # d_spectral > 0 when --use-spectral is active: spectral features are
        # concatenated to the backbone embedding before this head.
        self.d_spectral = d_spectral
        d_in = d_model + d_spectral
        self.net = nn.Sequential(
            nn.Linear(d_in, 96), nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(96, 48),   nn.GELU(),
            nn.Linear(48, self.N_STATES),
        )

    def forward(self, h):
        # h: (B, d_model) or (B, d_model+d_spectral) → (B, N_STATES)
        return self.net(h)


def attach_internal_state_head(backbone: "BiMambaAPF",
                               head: "InternalStateHead | None" = None,
                               dropout: float = 0.1) -> InternalStateHead:
    """Attach a fresh (or provided) InternalStateHead to a BiMambaAPF backbone
    so `backbone.forward_with_internal_states(...)` works. Returns the head."""
    if head is None:
        head = InternalStateHead(d_model=backbone.d_model, dropout=dropout)
    backbone.internal_state_head = head
    return head
