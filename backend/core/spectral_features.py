"""
core/spectral_features.py — Phase C ablation: spectral / wavelet-like features
from raw V/I traces.

What this module produces, per channel (e.g. voltage and current independently):
  * 4 statistical moments  (mean, std, skewness, kurtosis)
  * 3 spectral summaries   (centroid, rolloff_95, total power)
  * 3 top-magnitude peaks  (freq + magnitude for k = 1..3)
  * 5 octave-band energies (low → high)  — wavelet-packet-energy equivalent

= 4 + 3 + 6 + 5 = 18 features per channel.

`scipy.fft` + `scipy.stats` are the only dependencies (both already required
elsewhere in the project), so this ablation runs in the standard env.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable

import numpy as np

try:
    from scipy.fft import rfft, rfftfreq
    from scipy.stats import skew, kurtosis
    _HAVE_SCIPY = True
except Exception:                                            # pragma: no cover
    _HAVE_SCIPY = False

try:
    import pywt
    _HAVE_PYWT = True
except Exception:                                            # pragma: no cover
    _HAVE_PYWT = False


WAVELET            = "db4"     # Daubechies-4 — standard for ML feature work
WAVELET_LEVEL      = 3         # 3-level decomposition → 2^3 = 8 packet bands
N_OCTAVE_BANDS     = 8         # matches the wavelet packet count
N_FEATURES_PER_CHANNEL = 4 + 3 + 6 + N_OCTAVE_BANDS          # = 21


@dataclass
class SpectralFeatures:
    moments:        list[float]            # mean, std, skewness, kurtosis
    spectral_summary: list[float]          # centroid, rolloff95, total_power
    top_peaks:      list[float]            # [f1, m1, f2, m2, f3, m3]
    band_energies:  list[float]            # 5 octave bands low→high

    def as_vector(self) -> np.ndarray:
        return np.array(
            self.moments + self.spectral_summary + self.top_peaks + self.band_energies,
            dtype=np.float32,
        )


def _safe_moments(x: np.ndarray) -> list[float]:
    if x.size < 2:
        return [float(np.mean(x) if x.size else 0.0), 0.0, 0.0, 0.0]
    m, s = float(np.mean(x)), float(np.std(x))
    if s < 1e-12:
        return [m, 0.0, 0.0, 0.0]                # zero-variance: skew/kurt undefined
    if _HAVE_SCIPY:
        sk = skew(x, bias=False)
        kt = kurtosis(x, bias=False)
        return [m, s,
                0.0 if not np.isfinite(sk) else float(sk),
                0.0 if not np.isfinite(kt) else float(kt)]
    z = (x - m) / s
    return [m, s, float(np.mean(z ** 3)), float(np.mean(z ** 4) - 3.0)]


def _spectral(x: np.ndarray, fs: float) -> tuple[list[float], list[float], list[float]]:
    """Returns (spectral_summary, top_peaks, band_energies)."""
    if x.size < 4:
        return [0.0, 0.0, 0.0], [0.0] * 6, [0.0] * N_OCTAVE_BANDS

    x = x - np.mean(x)
    if _HAVE_SCIPY:
        spec = np.abs(rfft(x))
        freqs = rfftfreq(len(x), d=1.0 / fs)
    else:
        spec = np.abs(np.fft.rfft(x))
        freqs = np.fft.rfftfreq(len(x), d=1.0 / fs)

    power = spec ** 2
    total = float(power.sum()) + 1e-12

    centroid = float((freqs * power).sum() / total)
    cumP = np.cumsum(power) / total
    rolloff_idx = int(np.searchsorted(cumP, 0.95))
    rolloff = float(freqs[min(rolloff_idx, len(freqs) - 1)])

    # top-3 magnitude peaks (skip DC bin = index 0)
    if len(spec) > 1:
        order = np.argsort(spec[1:])[::-1] + 1
    else:
        order = np.array([0])
    top: list[float] = []
    for k in range(3):
        if k < len(order):
            j = int(order[k])
            top.extend([float(freqs[j]), float(spec[j])])
        else:
            top.extend([0.0, 0.0])

    # Wavelet-packet energy: full N_OCTAVE_BANDS-band decomposition via PyWavelets
    # if installed, otherwise log-uniform FFT bin sum as a faithful fallback.
    band_e = _wavelet_packet_energies(x)
    return [centroid, rolloff, total], top, band_e


def _wavelet_packet_energies(x: np.ndarray) -> list[float]:
    """Energy per leaf of a level-`WAVELET_LEVEL` wavelet packet tree, ordered
    low → high in natural frequency order.

    Returns N_OCTAVE_BANDS values normalized so they sum to ~1.
    Falls back to log-uniform FFT bins if PyWavelets isn't available.
    """
    if _HAVE_PYWT and len(x) >= 2 ** WAVELET_LEVEL:
        try:
            wp = pywt.WaveletPacket(data=x, wavelet=WAVELET, mode="symmetric",
                                    maxlevel=WAVELET_LEVEL)
            leaves = [node.path for node in wp.get_level(WAVELET_LEVEL, "natural")]
            energies = [float(np.sum(wp[p].data ** 2)) for p in leaves]
            tot = sum(energies) + 1e-12
            return [e / tot for e in energies][:N_OCTAVE_BANDS] + \
                   [0.0] * max(0, N_OCTAVE_BANDS - len(energies))
        except Exception:
            pass
    # Fallback: log-uniform FFT bin sum
    if _HAVE_SCIPY:
        spec = np.abs(rfft(x - np.mean(x))) ** 2
        freqs = rfftfreq(len(x), d=1.0)
    else:
        spec = np.abs(np.fft.rfft(x - np.mean(x))) ** 2
        freqs = np.fft.rfftfreq(len(x), d=1.0)
    f_max = float(freqs[-1]) if len(freqs) > 0 else 0.5
    f_min = max(1e-3, f_max / (2 ** N_OCTAVE_BANDS))
    edges = np.geomspace(f_min, f_max, N_OCTAVE_BANDS + 1)
    tot = float(spec.sum()) + 1e-12
    return [float(spec[(freqs >= edges[i]) & (freqs < edges[i + 1])].sum() / tot)
            for i in range(N_OCTAVE_BANDS)]


def compute_spectral_features(signal: Iterable[float], fs: float = 1.0) -> SpectralFeatures:
    """Compute the 18-feature spectral vector for one signal channel.

    `fs` is the sampling frequency in the time-unit of the cycle index. For
    per-cycle features pass fs=1 (1 sample per cycle). For raw V(t)/I(t)
    traces sampled at a uniform Δt, pass fs=1/Δt.
    """
    x = np.asarray(signal, dtype=np.float64).flatten()
    moments = _safe_moments(x)
    spec_sum, peaks, bands = _spectral(x, fs)
    return SpectralFeatures(
        moments=moments,
        spectral_summary=spec_sum,
        top_peaks=peaks,
        band_energies=bands,
    )


def features_from_window(window: np.ndarray, voltage_col: int = 2,
                         current_col: int = 6, fs: float = 1.0) -> np.ndarray:
    """For a (T, F) per-cycle window, compute concatenated spectral features
    for voltage and current channels.

    Returns: float32 vector of length 2 * N_FEATURES_PER_CHANNEL = 36.
    Channels missing from the window contribute zero-vectors.
    """
    if window.ndim != 2:
        raise ValueError("window must be 2D (T, F)")
    T, F = window.shape
    v_vec = (compute_spectral_features(window[:, voltage_col], fs).as_vector()
             if voltage_col < F else np.zeros(N_FEATURES_PER_CHANNEL, dtype=np.float32))
    i_vec = (compute_spectral_features(window[:, current_col], fs).as_vector()
             if current_col < F else np.zeros(N_FEATURES_PER_CHANNEL, dtype=np.float32))
    return np.concatenate([v_vec, i_vec]).astype(np.float32)


def status() -> dict:
    return {
        "have_scipy":              _HAVE_SCIPY,
        "have_pywt":               _HAVE_PYWT,
        "wavelet":                 WAVELET if _HAVE_PYWT else "fft-fallback",
        "wavelet_level":           WAVELET_LEVEL,
        "n_features_per_channel":  N_FEATURES_PER_CHANNEL,
        "n_packet_bands":          N_OCTAVE_BANDS,
        "default_channels":        ["voltage", "current"],
    }
