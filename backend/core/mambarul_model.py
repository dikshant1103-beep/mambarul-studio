"""
Self-contained MambaRUL model definition for inference.
Reconstructed from checkpoint state dict analysis to match saved weights exactly.

Architecture (from thesis_results/v10_final checkpoint):
  - ChemInputProjection (CIP): LFP-specific Linear(18→13), others identity
  - core.input_proj: Linear(13→128) + LayerNorm(128)
  - core.pos_enc: Learnable positional encoding (1, 30, 128)
  - core.mamba_blocks: 3× MambaBlock(d_model=128, d_state=16, d_conv=4, expand=2)
  - core.cross_attn: DegradationAnchorAttention(128, 3 anchors)
  - core.final_norm: LayerNorm(128)
  - core.mlp_head: Linear(128→64) + ReLU + Dropout + Linear(64→1)

v10-full / v8 / v9 have same core architecture without CIP wrapper.
TCN-Mamba uses separate TCNMambaModel class.
"""
import math
import torch
import torch.nn as nn
import torch.nn.functional as F


# ─────────────────────────────────────────────────────────────────
# MambaBlock — selective SSM
# ─────────────────────────────────────────────────────────────────

class MambaBlock(nn.Module):
    def __init__(self, d_model=128, d_state=16, d_conv=4, expand=2, dropout=0.1):
        super().__init__()
        self.d_model = d_model
        self.d_state = d_state
        self.d_inner = int(expand * d_model)

        self.in_proj  = nn.Linear(d_model, self.d_inner * 2, bias=False)
        self.conv1d   = nn.Conv1d(self.d_inner, self.d_inner, d_conv,
                                  padding=d_conv - 1, groups=self.d_inner, bias=True)
        self.x_proj   = nn.Linear(self.d_inner, d_state * 2 + self.d_inner, bias=False)
        self.dt_proj  = nn.Linear(self.d_inner, self.d_inner, bias=True)

        A = torch.arange(1, d_state + 1, dtype=torch.float32).unsqueeze(0).expand(self.d_inner, -1)
        self.A_log = nn.Parameter(torch.log(A))
        self.D     = nn.Parameter(torch.ones(self.d_inner))
        self.out_proj = nn.Linear(self.d_inner, d_model, bias=False)
        self.norm     = nn.LayerNorm(d_model)
        self.dropout  = nn.Dropout(dropout)

    def ssm(self, x):
        B, L, D = x.shape; S = self.d_state
        xz   = self.x_proj(x)
        B_m  = xz[..., :S]; C_m = xz[..., S:2*S]; dt_r = xz[..., 2*S:]
        dt   = F.softplus(self.dt_proj(dt_r))
        A    = -torch.exp(self.A_log.float())
        dA   = torch.exp(dt.unsqueeze(-1) * A.unsqueeze(0).unsqueeze(0))
        dB   = dt.unsqueeze(-1) * B_m.unsqueeze(2)
        h    = torch.zeros(B, D, S, device=x.device, dtype=x.dtype)
        ys   = []
        for t in range(L):
            h = dA[:, t] * h + dB[:, t] * x[:, t].unsqueeze(-1)
            ys.append((h * C_m[:, t].unsqueeze(1)).sum(-1))
        y = torch.stack(ys, dim=1)
        return y + x * self.D.unsqueeze(0).unsqueeze(0)

    def forward(self, x):
        residual = x; x = self.norm(x)
        xz = self.in_proj(x); x_in, z = xz.chunk(2, dim=-1)
        x_c = self.conv1d(x_in.transpose(1, 2))[..., :x_in.shape[1]].transpose(1, 2)
        x_c = F.silu(x_c)
        y   = self.ssm(x_c) * F.silu(z)
        return self.dropout(self.out_proj(y)) + residual


# ─────────────────────────────────────────────────────────────────
# DegradationAnchorAttention
# ─────────────────────────────────────────────────────────────────

class DegradationAnchorAttention(nn.Module):
    def __init__(self, d_model=128, n_heads=4, n_anchors=3, dropout=0.1):
        super().__init__()
        self.d_k      = d_model // n_heads
        self.n_heads  = n_heads
        self.anchors  = nn.Parameter(torch.randn(n_anchors, d_model) * 0.02)
        self.W_q      = nn.Linear(d_model, d_model, bias=False)
        self.W_k      = nn.Linear(d_model, d_model, bias=False)
        self.W_v      = nn.Linear(d_model, d_model, bias=False)
        self.W_o      = nn.Linear(d_model, d_model, bias=False)
        self.norm     = nn.LayerNorm(d_model)
        self.dropout  = nn.Dropout(dropout)

    def forward(self, x):
        B, L, D = x.shape; H = self.n_heads; dk = self.d_k
        residual = x; x = self.norm(x)
        A = self.anchors.unsqueeze(0).expand(B, -1, -1)
        Q = self.W_q(x).view(B, L, H, dk).transpose(1, 2)
        K = self.W_k(A).view(B, -1, H, dk).transpose(1, 2)
        V = self.W_v(A).view(B, -1, H, dk).transpose(1, 2)
        attn = torch.softmax(Q @ K.transpose(-2, -1) / math.sqrt(dk), dim=-1)
        out  = (attn @ V).transpose(1, 2).contiguous().view(B, L, D)
        return self.dropout(self.W_o(out)) + residual


# ─────────────────────────────────────────────────────────────────
# LearnablePositionalEncoding
# ─────────────────────────────────────────────────────────────────

class LearnablePositionalEncoding(nn.Module):
    def __init__(self, max_len=30, d_model=128, dropout=0.1):
        super().__init__()
        self.pe      = nn.Parameter(torch.randn(1, max_len, d_model) * 0.02)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x):
        return self.dropout(x + self.pe[:, :x.size(1)])


# ─────────────────────────────────────────────────────────────────
# MambaRULCore — used for v8/v9/v10-full (no CIP wrapper)
# ─────────────────────────────────────────────────────────────────

class MambaRULCore(nn.Module):
    """Matches v8, v9, v10-full checkpoint state dicts."""
    def __init__(self, n_features=13, d_model=128, n_mamba=3,
                 d_state=16, d_conv=4, expand=2, n_anchors=3, dropout=0.1):
        super().__init__()
        self.input_proj = nn.Sequential(
            nn.Linear(n_features, d_model), nn.LayerNorm(d_model))
        self.pos_enc     = LearnablePositionalEncoding(30, d_model, dropout)
        self.mamba_blocks = nn.ModuleList([
            MambaBlock(d_model, d_state, d_conv, expand, dropout)
            for _ in range(n_mamba)])
        self.cross_attn  = DegradationAnchorAttention(d_model, 4, n_anchors, dropout)
        self.final_norm  = nn.LayerNorm(d_model)
        self.mlp_head    = nn.Sequential(
            nn.Linear(d_model, 64), nn.ReLU(), nn.Dropout(dropout), nn.Linear(64, 1))

    def forward(self, x):
        x = self.pos_enc(self.input_proj(x))
        for mb in self.mamba_blocks:
            x = mb(x)
        x = self.cross_attn(x)
        x = self.final_norm(x)
        x = x.mean(dim=1)
        return self.mlp_head(x).squeeze(-1)


# ─────────────────────────────────────────────────────────────────
# ChemInputProjection + MambaRULFinal — v10-final only
# ─────────────────────────────────────────────────────────────────

class ChemInputProjection(nn.Module):
    def __init__(self, n_features_lfp=18, n_features_base=13):
        super().__init__()
        self.lfp_proj = nn.Linear(n_features_lfp, n_features_base)

    def forward(self, x, chem_code=None):
        # For inference: always use base 13-feature path (non-LFP or LFP without IC)
        return x


class MambaRULFinal(nn.Module):
    """Matches v10-final checkpoint: cip.* + core.* keys."""
    def __init__(self, n_features=13, d_model=128, n_mamba=3,
                 d_state=16, d_conv=4, expand=2, n_anchors=3, dropout=0.1):
        super().__init__()
        self.cip  = ChemInputProjection()
        self.core = MambaRULCore(n_features, d_model, n_mamba,
                                  d_state, d_conv, expand, n_anchors, dropout)

    def forward(self, x):
        x = self.cip(x)
        return self.core(x)


# ─────────────────────────────────────────────────────────────────
# TCN-Mamba (simplified for inference from tcn_mamba_rul)
# ─────────────────────────────────────────────────────────────────

class TCNBlock(nn.Module):
    def __init__(self, in_ch, out_ch, kernel, dilation, dropout=0.1):
        super().__init__()
        pad = (kernel - 1) * dilation
        self.conv = nn.Conv1d(in_ch, out_ch, kernel, dilation=dilation, padding=pad)
        self.norm = nn.GroupNorm(1, out_ch)
        self.drop = nn.Dropout(dropout)
        self.res  = nn.Conv1d(in_ch, out_ch, 1) if in_ch != out_ch else nn.Identity()

    def forward(self, x):
        L = x.shape[-1]
        y = F.relu(self.norm(self.conv(x)[..., :L]))
        return self.drop(y) + self.res(x)


class FeatureAwareProjection(nn.Module):
    def __init__(self, n_features, hidden):
        super().__init__()
        self.proj = nn.Linear(n_features * 2, hidden)
        self.norm = nn.LayerNorm(hidden)

    def forward(self, x, mask=None):
        if mask is None:
            mask = torch.ones(x.shape[0], x.shape[2], device=x.device)
        xm = x * mask.unsqueeze(1)
        xcat = torch.cat([xm, mask.unsqueeze(1).expand_as(xm)], dim=-1)
        return self.norm(self.proj(xcat))


class TCNMambaModel(nn.Module):
    """Simplified TCN-Mamba for inference."""
    def __init__(self, n_features=30, hidden=64, dropout=0.1):
        super().__init__()
        self.input_proj = FeatureAwareProjection(n_features, hidden)
        self.tcn = nn.ModuleList([
            TCNBlock(hidden, hidden, 3, 1, dropout),
            TCNBlock(hidden, 128,   3, 2, dropout),
            TCNBlock(128,    128,   5, 4, dropout),
        ])
        self.mamba = nn.ModuleList([
            MambaBlock(128, 16, 4, 2, dropout) for _ in range(3)])
        self.pool  = nn.Linear(128, 1)
        self.head_0 = nn.Sequential(nn.Linear(128, 64), nn.GELU(), nn.Dropout(dropout), nn.Linear(64, 1), nn.Softplus())
        self.head_1 = nn.Sequential(nn.Linear(128, 64), nn.GELU(), nn.Dropout(dropout), nn.Linear(64, 1), nn.Softplus())
        self.head_2 = nn.Sequential(nn.Linear(128, 64), nn.GELU(), nn.Dropout(dropout), nn.Linear(64, 1), nn.Softplus())
        self.head_3 = nn.Sequential(nn.Linear(128, 64), nn.GELU(), nn.Dropout(dropout), nn.Linear(64, 1), nn.Softplus())

    def forward(self, x, chem_code=0):
        h = self.input_proj(x)          # (B, L, 64)
        h = h.transpose(1, 2)           # (B, 64, L)
        for tcn in self.tcn:
            h = tcn(h)
        h = h.transpose(1, 2)           # (B, L, 128)
        for mb in self.mamba:
            h = mb(h)
        w = torch.softmax(self.pool(h).squeeze(-1), dim=-1)
        pooled = (h * w.unsqueeze(-1)).sum(1)  # (B, 128)
        # Use head 0 (LCO) as default for single-output inference
        return self.head_0(pooled).squeeze(-1)


# ─────────────────────────────────────────────────────────────────
# MambaRULTwoHead — v11: joint SOH + RUL prediction
# ─────────────────────────────────────────────────────────────────

class MambaRULTwoHead(nn.Module):
    """v11: joint SOH + RUL from shared Mamba backbone.

    Backbone (cip.* + core.*) is structurally identical to MambaRULFinal,
    so v10 checkpoint keys load directly with strict=False.
    soh_head.* is new and trained from scratch (Phase 1 freeze → Phase 2 joint).

    forward() returns (rul_norm, soh) where:
      rul_norm : normalised RUL (same scale as v10 output)
      soh      : SOH in [0, 1] (0 = dead, 1 = fresh)
    """

    def __init__(self, n_features=13, d_model=128, n_mamba=3,
                 d_state=16, d_conv=4, expand=2, n_anchors=3, dropout=0.1):
        super().__init__()
        self.cip  = ChemInputProjection()
        self.core = MambaRULCore(n_features, d_model, n_mamba,
                                  d_state, d_conv, expand, n_anchors, dropout)
        self.soh_head = nn.Sequential(
            nn.Linear(d_model, 64),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(64, 1),
            nn.Sigmoid(),
        )

    def forward_features(self, x):
        """Shared 128-dim embedding before task heads."""
        x = self.cip(x)
        x = self.core.pos_enc(self.core.input_proj(x))
        for mb in self.core.mamba_blocks:
            x = mb(x)
        x = self.core.cross_attn(x)
        x = self.core.final_norm(x)
        return x.mean(dim=1)   # (B, 128)

    def forward(self, x):
        h   = self.forward_features(x)
        rul = self.core.mlp_head(h).squeeze(-1)
        soh = self.soh_head(h).squeeze(-1)
        return rul, soh
