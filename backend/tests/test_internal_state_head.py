"""
Phase C marquee test: the auxiliary internal-state head + training loop.

Verifies the architecture wires correctly, the multi-task loss back-props,
and the head checkpoint round-trips. Synthetic data so it runs in any env.
"""
from pathlib import Path

import torch

from core.bimamba_apf import BiMambaAPF, InternalStateHead, attach_internal_state_head


def test_head_forward_shapes():
    m = BiMambaAPF()
    head = attach_internal_state_head(m)
    x = torch.randn(3, 30, 13)
    rul, soh, internal = m.forward_with_internal_states(x)
    assert tuple(rul.shape) == (3,)
    assert tuple(soh.shape) == (3,)
    assert tuple(internal.shape) == (3, head.N_STATES)


def test_forward_without_attached_head_raises():
    m = BiMambaAPF()
    try:
        m.forward_with_internal_states(torch.randn(1, 30, 13))
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        assert "internal_state_head" in str(exc)


def test_multitask_loss_propagates_to_head_only_when_backbone_frozen():
    m = BiMambaAPF()
    head = attach_internal_state_head(m)
    for p in m.parameters():
        p.requires_grad = False
    for p in head.parameters():
        p.requires_grad = True

    x = torch.randn(2, 30, 13)
    y_rul = torch.zeros(2)
    y_soh = torch.full((2,), 0.5)
    y_int = torch.zeros(2, head.N_STATES)

    pred_rul, pred_soh, pred_int = m.forward_with_internal_states(x)
    loss = (pred_rul - y_rul).pow(2).mean() + \
           (pred_soh - y_soh).pow(2).mean() + \
           (pred_int - y_int).pow(2).mean()
    loss.backward()

    # head params have gradients
    head_grads = [p.grad for p in head.parameters() if p.grad is not None]
    assert head_grads, "head received no gradients"
    # backbone params did not receive gradients (frozen)
    for p in m.input_proj.parameters():
        assert p.grad is None


def test_smoke_training_loop_loss_decreases_and_checkpoint_roundtrips(tmp_path):
    # Import the script as a module via path-shim
    import importlib.util, sys
    script = Path(__file__).resolve().parent.parent.parent / "scripts" / "train_internal_state_head.py"
    spec = importlib.util.spec_from_file_location("tish", str(script))
    mod  = importlib.util.module_from_spec(spec); sys.modules["tish"] = mod
    spec.loader.exec_module(mod)

    m = mod.train_smoke(epochs=4, lr=3e-3, lam_aux=1.0,
                        batches_per_epoch=5, batch_size=8,
                        out_dir=tmp_path)
    assert m["ok"] is True
    assert m["loss_decreased"] is True
    assert m["head_params"] > 0
    # checkpoint loads back into a fresh head with matching state-dict keys
    ck = torch.load(m["checkpoint"], weights_only=False)
    assert ck["n_states"] == InternalStateHead.N_STATES
    fresh = InternalStateHead(d_model=ck["d_model"])
    fresh.load_state_dict(ck["head_state_dict"])
