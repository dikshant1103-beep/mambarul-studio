"""Smoke tests for the Helm chart at deploy/helm/batteryos.

Validates structure + YAML syntax of static manifests. Template files
contain Go-templating ({{ ... }}) and are not parsed as YAML here;
they're verified as present + non-empty.
"""
from pathlib import Path

import pytest
import yaml


CHART_ROOT = Path(__file__).resolve().parent.parent.parent / "deploy" / "helm" / "batteryos"


def test_chart_directory_exists():
    assert CHART_ROOT.is_dir(), f"missing Helm chart at {CHART_ROOT}"


def test_chart_yaml_is_valid():
    chart = yaml.safe_load((CHART_ROOT / "Chart.yaml").read_text())
    assert chart["name"] == "batteryos"
    assert chart["apiVersion"] == "v2"
    assert "version" in chart
    assert "appVersion" in chart


def test_values_yaml_is_valid():
    vals = yaml.safe_load((CHART_ROOT / "values.yaml").read_text())
    assert vals["replicaCount"] >= 1
    assert vals["service"]["targetPort"] == 8000
    assert vals["autoscaling"]["enabled"] is True
    assert vals["postgresql"]["image"]["repository"] == "timescale/timescaledb"
    assert vals["probes"]["liveness"]["path"] == "/api/health"


@pytest.mark.parametrize("name", [
    "deployment.yaml", "service.yaml", "ingress.yaml",
    "hpa.yaml", "pvc.yaml", "_helpers.tpl", "NOTES.txt",
])
def test_template_present_and_non_empty(name):
    p = CHART_ROOT / "templates" / name
    assert p.exists(), f"missing template: {name}"
    assert p.stat().st_size > 50
