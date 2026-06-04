/** Shared Plotly dark layout — import and spread in every chart */
export const darkLayout: Partial<Plotly.Layout> = {
  paper_bgcolor: 'transparent',
  plot_bgcolor: 'transparent',
  font: { color: '#94a3b8', family: 'Inter, system-ui, sans-serif', size: 11 },
  xaxis: {
    gridcolor: '#1e3a5f',
    zerolinecolor: '#1e3a5f',
    linecolor: '#1e3a5f',
    tickcolor: '#475569',
    tickfont: { color: '#64748b', size: 10 },
  },
  yaxis: {
    gridcolor: '#1e3a5f',
    zerolinecolor: '#1e3a5f',
    linecolor: '#1e3a5f',
    tickcolor: '#475569',
    tickfont: { color: '#64748b', size: 10 },
  },
  legend: {
    font: { color: '#94a3b8', size: 10 },
    bgcolor: 'rgba(17,24,39,0.8)',
    bordercolor: '#1e3a5f',
    borderwidth: 1,
  },
  hoverlabel: {
    bgcolor: '#1a2233',
    bordercolor: '#3b82f6',
    font: { color: '#f1f5f9', size: 11 },
  },
  margin: { t: 20, b: 50, l: 60, r: 20 },
}

export const plotConfig: Partial<Plotly.Config> = {
  displayModeBar: true,
  displaylogo: false,
  toImageButtonOptions: { format: 'png', scale: 2, filename: 'mambaRUL_chart' },
  responsive: true,
}
