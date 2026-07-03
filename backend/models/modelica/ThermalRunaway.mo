// ThermalRunaway.mo — Modelica model for chained thermal-runaway propagation
// in a battery pack. Each cell has a lumped thermal mass, Joule heating from
// I^2 * R_int, conductive coupling to its neighbours via thermal resistance,
// and an exothermic decomposition term that switches on above T_trigger
// (Arrhenius form). When a cell exceeds T_trigger, its decomposition heat
// raises the neighbour temperatures and the failure can propagate.
//
// Compile + simulate with OpenModelica:
//     omc +s ThermalRunaway.mo
//     ./ThermalRunaway -override stopTime=120,stepSize=0.1
//
// The Python wrapper at core/openmodelica_runner.py invokes this when `omc`
// is available on PATH and falls back to an analytical propagation otherwise.

model ThermalRunaway
  parameter Integer N             = 4         "number of cells";
  parameter Real    Cth(unit="J/K")   = 80    "lumped thermal mass / cell";
  parameter Real    Rint(unit="ohm")  = 0.04  "internal resistance / cell";
  parameter Real    Rcoup(unit="K/W") = 1.5   "thermal coupling resistance";
  parameter Real    Rext(unit="K/W")  = 8.0   "ambient thermal resistance / cell";
  parameter Real    T_amb(unit="degC") = 25.0 "ambient temperature";
  parameter Real    I_load(unit="A")   = 30.0 "discharge current (Joule heating)";

  parameter Real    T_trigger(unit="degC")  = 120.0 "decomposition onset";
  parameter Real    Q_decomp(unit="J")      = 1.5e5 "total heat released per cell";
  parameter Real    tau_decomp(unit="s")    = 8.0   "decomposition time constant";
  parameter Real    Ea_over_R(unit="K")     = 12000 "activation energy / R";
  parameter Real    T_init[N]               = fill(T_amb, N) "initial °C";
  parameter Integer trigger_cell            = 1     "seed-failure cell index (1-based)";
  parameter Real    trigger_at(unit="s")    = 5.0   "time the seed cell is forced over T_trigger";

  Real T[N](start = T_init)         "cell temperatures °C";
  Real q_decomp[N](start = fill(0, N))    "instantaneous decomposition heat W";
  Real Q_remaining[N](start = fill(Q_decomp, N))  "remaining decomposition energy J";
  Boolean tripped[N](start = fill(false, N));

equation
  for i in 1:N loop
    // conductive coupling to nearest neighbours (line topology)
    Cth * der(T[i]) =
        // ohmic heating
        I_load^2 * Rint
        // ambient loss
      - (T[i] - T_amb) / Rext
        // coupling to left neighbour
      + (if i > 1 then (T[i-1] - T[i]) / Rcoup else 0)
        // coupling to right neighbour
      + (if i < N then (T[i+1] - T[i]) / Rcoup else 0)
        // exothermic decomposition (after trigger)
      + q_decomp[i];

    // Post-trigger decomposition: release at Q_rem / tau_decomp. Arrhenius
    // gates the trigger event, not the post-trip rate — at room temperature
    // the exp(-Ea/RT) factor is ~1e-15 and runaway would never propagate.
    // Matches Hatchard / Spotnitz simplified one-step decomposition.
    q_decomp[i] = if tripped[i] and Q_remaining[i] > 0 then
                     Q_remaining[i] / tau_decomp
                  else 0;
    der(Q_remaining[i]) = -q_decomp[i];
  end for;

  // event: seed cell forced above T_trigger after `trigger_at`
algorithm
  for i in 1:N loop
    if not tripped[i] and (T[i] >= T_trigger or (i == trigger_cell and time >= trigger_at)) then
      tripped[i] := true;
    end if;
  end for;
end ThermalRunaway;
