"""tests for core/spectral_features.py."""
import numpy as np
import pytest


def test_constant_signal_has_zero_variance():
    from core.spectral_features import compute_spectral_features
    s = compute_spectral_features([3.7] * 32, fs=1.0)
    v = s.as_vector()
    assert v[0] == pytest.approx(3.7)        # mean
    assert v[1] == pytest.approx(0.0)        # std
    assert v[2] == 0.0                       # skew
    assert v[3] == 0.0                       # kurt


def test_sine_dominant_frequency_recovered():
    from core.spectral_features import compute_spectral_features
    fs = 100.0
    t = np.arange(0, 4.0, 1.0 / fs)
    x = np.sin(2 * np.pi * 5.0 * t)          # 5 Hz pure tone
    s = compute_spectral_features(x, fs=fs)
    f1, m1 = s.top_peaks[0], s.top_peaks[1]
    assert abs(f1 - 5.0) < 0.5
    assert m1 > 0


def test_vector_length_matches_advertised():
    from core.spectral_features import (
        compute_spectral_features, N_FEATURES_PER_CHANNEL,
    )
    v = compute_spectral_features(np.random.randn(64), fs=10.0).as_vector()
    assert len(v) == N_FEATURES_PER_CHANNEL


def test_window_features_shape_and_zero_for_missing_channel():
    from core.spectral_features import features_from_window, N_FEATURES_PER_CHANNEL
    w = np.random.randn(30, 9).astype(np.float32)
    out = features_from_window(w, voltage_col=2, current_col=6, fs=1.0)
    assert out.shape == (2 * N_FEATURES_PER_CHANNEL,)
    # absent channels collapse to zero
    w2 = np.random.randn(30, 2).astype(np.float32)
    out2 = features_from_window(w2, voltage_col=10, current_col=11, fs=1.0)
    assert out2.shape == (2 * N_FEATURES_PER_CHANNEL,)
    assert np.allclose(out2, 0.0)


def test_octave_band_energies_sum_close_to_one():
    from core.spectral_features import compute_spectral_features
    fs = 50.0
    t = np.arange(0, 4.0, 1.0 / fs)
    x = np.sin(2 * np.pi * 5 * t) + 0.5 * np.sin(2 * np.pi * 15 * t)
    bands = compute_spectral_features(x, fs=fs).band_energies
    # power normalized to total; sum should be ≤1 and >0.5 for a clean signal
    s = sum(bands)
    assert 0.5 < s <= 1.0 + 1e-6


def test_wavelet_packet_decomp_when_pywt_available():
    pytest.importorskip("pywt")
    from core.spectral_features import compute_spectral_features, N_OCTAVE_BANDS, status
    st = status()
    assert st["have_pywt"] is True
    # A signal where energy concentrates in the high frequencies should put most
    # energy in higher-index bands (PyWavelets natural order = low→high).
    fs = 64.0
    t = np.arange(0, 4.0, 1.0 / fs)
    high = np.sin(2 * np.pi * 28 * t)
    bands_high = compute_spectral_features(high, fs=fs).band_energies
    assert sum(bands_high[N_OCTAVE_BANDS // 2:]) > sum(bands_high[:N_OCTAVE_BANDS // 2])
