import { describe, it, expect } from 'vitest'
import { bestModelForChem } from './ModelSelector'

const m = (id: string, loaded = true) => ({ id, loaded, description: '' })

describe('bestModelForChem', () => {
  it('prefers the chemistry-affine fine-tuned model when loaded', () => {
    expect(bestModelForChem('LFP', [m('hust-lfp'), m('v12-bimamba')])).toBe('hust-lfp')
    expect(bestModelForChem('NMC', [m('oxford-nmc'), m('v12-bimamba')])).toBe('oxford-nmc')
  })

  it('falls back down the affinity order when the top choice is not loaded', () => {
    expect(bestModelForChem('LFP', [m('hust-lfp', false), m('v12-bimamba')])).toBe('v12-bimamba')
    expect(bestModelForChem('NMC', [m('oxford-nmc', false), m('nasa-nmc', false), m('v12-bimamba')])).toBe('v12-bimamba')
  })

  it('falls back to v10-final when nothing affine is loaded', () => {
    expect(bestModelForChem('NMC', [])).toBe('v10-final')
    expect(bestModelForChem('LFP', [m('hust-lfp', false)])).toBe('v10-final')
  })

  it('uses v12-bimamba for NCM/NCA/LCO when loaded, else v10-final', () => {
    expect(bestModelForChem('NCM', [m('v12-bimamba')])).toBe('v12-bimamba')
    expect(bestModelForChem('NCA', [m('v12-bimamba')])).toBe('v12-bimamba')
    expect(bestModelForChem('LCO', [m('v12-bimamba', false)])).toBe('v10-final')
  })

  it('returns v10-final for unknown chemistry', () => {
    expect(bestModelForChem('SODIUM', [m('v12-bimamba')])).toBe('v10-final')
  })
})
