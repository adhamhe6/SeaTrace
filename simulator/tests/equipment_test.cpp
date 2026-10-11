#include <gtest/gtest.h>

#include <algorithm>
#include <cmath>
#include <nlohmann/json.hpp>

#include "test_support.hpp"

namespace seatrace::sim {
namespace {

using namespace testing;
using namespace std::chrono_literals;

constexpr const char* kVessel = "VES-001";

// ---- initial state and metadata ---------------------------------------------------------------

TEST(Equipment, DefaultFleetStartsRunningAndHealthy) {
  Simulation sim = make_simulation();
  for (const auto& vessel : sim.vessels()) {
    EXPECT_EQ(state_of(sim, vessel->code(), "ME1"), EquipmentState::kRunning);
    EXPECT_EQ(state_of(sim, vessel->code(), "GEN1"), EquipmentState::kRunning);
    EXPECT_EQ(state_of(sim, vessel->code(), "COOL1"), EquipmentState::kRunning);
    EXPECT_EQ(state_of(sim, vessel->code(), "BILGE1"), EquipmentState::kStandby);
    for (const auto& equipment : vessel->equipment()) {
      EXPECT_EQ(equipment->sensor_health(), SensorHealth::kOk) << equipment->code();
      for (const Sensor& sensor : equipment->sensors()) {
        EXPECT_EQ(sensor.reading().quality, Quality::kGood);
        EXPECT_TRUE(std::isfinite(sensor.reading().value));
      }
    }
    EXPECT_FALSE(vessel->telemetry_interrupted());
  }
  EXPECT_EQ(sim.heartbeat(), 0U);
  EXPECT_EQ(sim.scenarios().active_json(), "[]");
}

TEST(Equipment, SensorsExposeUnitsAndKeysFromTheContract) {
  Simulation sim = make_simulation();
  const auto check = [&](std::string_view code,
                         std::vector<std::tuple<std::string, std::string, std::string>> expected) {
    const auto& sensors = equipment(sim, kVessel, code).sensors();
    ASSERT_EQ(sensors.size(), expected.size()) << code;
    for (std::size_t i = 0; i < expected.size(); ++i) {
      EXPECT_EQ(sensors[i].spec().name, std::get<0>(expected[i]));
      EXPECT_EQ(sensors[i].spec().key, std::get<1>(expected[i]));
      EXPECT_EQ(sensors[i].spec().unit, std::get<2>(expected[i]));
    }
  };
  check("ME1", {{"Rpm", "rpm", "rpm"},
                {"Temperature", "temperature", "°C"},
                {"Vibration", "vibration", "mm/s"},
                {"Load", "load", "%"}});
  check("GEN1", {{"PowerOutput", "power_output", "kW"},
                 {"Load", "load", "%"},
                 {"Frequency", "frequency", "Hz"}});
  check("COOL1", {{"Pressure", "pressure", "bar"}, {"Temperature", "temperature", "°C"}});
  check("BILGE1", {{"WaterLevel", "water_level", "cm"}});
  EXPECT_EQ(to_string(equipment(sim, kVessel, "ME1").type()), "MainEngine");
  EXPECT_EQ(to_string(equipment(sim, kVessel, "BILGE1").type()), "BilgeSystem");
}

TEST(Equipment, HealthyReadingsStayInsideTheNominalBandsWithMargin) {
  // Statistical envelope check over 40 simulated minutes for both vessels: every published
  // value stays within its nominal band widened by 5 sigma of the sensor noise plus 3 % of the
  // band.
  Simulation sim = make_simulation();
  for (int second = 0; second < 2400; ++second) {
    sim.step(1s);
    for (const auto& vessel : sim.vessels()) {
      for (const auto& equipment : vessel->equipment()) {
        for (const Sensor& sensor : equipment->sensors()) {
          const MeasurementSpec& spec = sensor.spec();
          const double slack =
              5.0 * spec.noise_sigma + 0.03 * (spec.nominal_max - spec.nominal_min);
          ASSERT_GE(sensor.reading().value, spec.nominal_min - slack)
              << vessel->code() << "." << equipment->code() << "." << spec.name << " t=" << second;
          ASSERT_LE(sensor.reading().value, spec.nominal_max + slack)
              << vessel->code() << "." << equipment->code() << "." << spec.name << " t=" << second;
        }
      }
      ASSERT_EQ(equipment(sim, vessel->code(), "ME1").state(), EquipmentState::kRunning);
      ASSERT_EQ(equipment(sim, vessel->code(), "BILGE1").state(), EquipmentState::kStandby);
    }
  }
}

TEST(Equipment, VesselsBehaveDifferently) {
  Simulation sim = make_simulation();
  run_seconds(sim, 120);
  EXPECT_NE(truth(sim, "VES-001", "GEN1", "power_output"),
            truth(sim, "VES-002", "GEN1", "power_output"));
  EXPECT_NE(truth(sim, "VES-001", "ME1", "load"), truth(sim, "VES-002", "ME1", "load"));
}

TEST(Equipment, GeneratorPowerIsLoadTimesRatedPowerAndFrequencyDroops) {
  Simulation sim = make_simulation();
  const double rated_kw = default_fleet().vessels[0].equipment[1].rated.at("power_kw");
  double min_frequency = 1e9;
  double max_frequency = -1e9;
  double lowest_load_frequency = 0.0;
  double lowest_load = 1e9;
  double highest_load_frequency = 0.0;
  double highest_load = -1e9;
  for (int i = 0; i < 1800; ++i) {
    sim.step(1s);
    const double load = truth(sim, kVessel, "GEN1", "load");
    const double frequency = truth(sim, kVessel, "GEN1", "frequency");
    ASSERT_NEAR(truth(sim, kVessel, "GEN1", "power_output"), load / 100.0 * rated_kw, 1e-9);
    min_frequency = std::min(min_frequency, frequency);
    max_frequency = std::max(max_frequency, frequency);
    if (load < lowest_load) {
      lowest_load = load;
      lowest_load_frequency = frequency;
    }
    if (load > highest_load) {
      highest_load = load;
      highest_load_frequency = frequency;
    }
  }
  EXPECT_GT(highest_load - lowest_load, 10.0) << "demand profile should vary";
  EXPECT_LT(highest_load_frequency, lowest_load_frequency) << "frequency droops with load";
  EXPECT_GT(min_frequency, 49.6);
  EXPECT_LT(max_frequency, 50.4);
}

// ---- state machines -------------------------------------------------------------------------

TEST(EngineStateMachine, TripsAfterSustainedOverTemperatureAndRestartsWhenCleared) {
  Simulation sim = make_simulation();
  const double trip_temperature = 118.0;
  activate(sim, kVessel, "engine_overheat");

  // Run until TRIPPED, counting how long the temperature was above the trip limit.
  int seconds_above_trip = 0;
  int consecutive_above_trip = 0;
  const int to_trip = run_until(
      sim,
      [&] {
        if (truth(sim, kVessel, "ME1", "temperature") > trip_temperature) {
          ++seconds_above_trip;
          ++consecutive_above_trip;
        } else {
          consecutive_above_trip = 0;
        }
        return state_of(sim, kVessel, "ME1") == EquipmentState::kTripped;
      },
      600);
  ASSERT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kTripped)
      << "no trip after " << to_trip << " s";
  EXPECT_GE(consecutive_above_trip, 5) << "the trip needs 5 s above the limit";
  EXPECT_LE(consecutive_above_trip, 7);
  EXPECT_GT(to_trip, 30) << "the trip must come from a gradual rise, not a jump";

  // After the trip: rpm decays to zero, vibration drops, the state is latched.
  run_seconds(sim, 120);
  EXPECT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kTripped);
  EXPECT_LT(truth(sim, kVessel, "ME1", "rpm"), 0.5);
  EXPECT_LT(truth(sim, kVessel, "ME1", "vibration"), 0.1);
  EXPECT_LT(truth(sim, kVessel, "ME1", "load"), 0.5);
  EXPECT_LT(truth(sim, kVessel, "ME1", "temperature"), 100.0) << "an idle engine cools down";
  run_seconds(sim, 120);
  EXPECT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kTripped)
      << "latched while the scenario is active";

  // Clear: STARTING for ~15 s, then RUNNING again.
  sim.take_state_changes();
  clear(sim, kVessel, "engine_overheat");
  run_until(sim, [&] { return state_of(sim, kVessel, "ME1") == EquipmentState::kStarting; }, 120);
  ASSERT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kStarting);
  run_seconds(sim, 14);
  EXPECT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kStarting);
  run_seconds(sim, 3);
  EXPECT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kRunning);

  // Durations from the recorded transitions.
  const auto changes = sim.take_state_changes();
  SimTime starting_at{};
  SimTime running_at{};
  for (const auto& change : changes) {
    if (change.equipment_code != "ME1") continue;
    if (change.to == EquipmentState::kStarting) starting_at = change.at;
    if (change.to == EquipmentState::kRunning) running_at = change.at;
  }
  EXPECT_NEAR(std::chrono::duration<double>(running_at - starting_at).count(), 15.0, 1.0);

  run_seconds(sim, 300);
  EXPECT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kRunning);
  EXPECT_GT(truth(sim, kVessel, "ME1", "rpm"), 85.0);
}

TEST(EngineStateMachine, ShortOverTemperatureDoesNotTrip) {
  // Clear the scenario as soon as the limit is crossed: the 5 s timer must not fire.
  Simulation sim = make_simulation();
  activate(sim, kVessel, "engine_overheat");
  run_until(sim, [&] { return truth(sim, kVessel, "ME1", "temperature") > 110.0; }, 300);
  clear(sim, kVessel, "engine_overheat");
  run_seconds(sim, 200);
  EXPECT_NE(state_of(sim, kVessel, "ME1"), EquipmentState::kTripped);
}

TEST(EngineStateMachine, DegradesOutsideTheEnvelopeAndRecovers) {
  Simulation sim = make_simulation();
  activate(sim, kVessel, "engine_vibration");
  run_until(sim, [&] { return state_of(sim, kVessel, "ME1") == EquipmentState::kDegraded; }, 300);
  EXPECT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kDegraded);
  clear(sim, kVessel, "engine_vibration");
  run_until(sim, [&] { return state_of(sim, kVessel, "ME1") == EquipmentState::kRunning; }, 600);
  EXPECT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kRunning);
}

FleetConfig fleet_with_stopped_engine(double auto_start_after_s) {
  FleetConfig fleet = default_fleet();
  EquipmentConfig& engine = fleet.vessels[0].equipment[0];
  engine.initial_state = EquipmentState::kStopped;
  if (auto_start_after_s > 0) engine.auto_start_after_s = auto_start_after_s;
  return fleet;
}

TEST(EngineStateMachine, ConfiguredStoppedEngineStaysStopped) {
  Simulation sim(fleet_with_stopped_engine(0), 42, kStartTime);
  EXPECT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kStopped);
  run_seconds(sim, 600);
  EXPECT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kStopped);
  EXPECT_EQ(truth(sim, kVessel, "ME1", "rpm"), 0.0);
  EXPECT_EQ(truth(sim, kVessel, "ME1", "vibration"), 0.0);
  EXPECT_EQ(truth(sim, kVessel, "ME1", "load"), 0.0);
  EXPECT_LT(truth(sim, kVessel, "ME1", "temperature"), 40.0);
  // The other vessel is not affected.
  EXPECT_EQ(state_of(sim, "VES-002", "ME1"), EquipmentState::kRunning);
}

TEST(EngineStateMachine, AutoStartRunsThroughStartingToRunning) {
  Simulation sim(fleet_with_stopped_engine(30), 42, kStartTime);
  run_seconds(sim, 29);
  EXPECT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kStopped);
  run_seconds(sim, 2);
  EXPECT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kStarting);
  EXPECT_GT(truth(sim, kVessel, "ME1", "rpm"), 0.0);
  run_seconds(sim, 16);
  EXPECT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kRunning);
  run_seconds(sim, 300);
  EXPECT_GT(truth(sim, kVessel, "ME1", "rpm"), 85.0);
  EXPECT_GT(truth(sim, kVessel, "ME1", "temperature"), 70.0);
}

TEST(GeneratorStateMachine, StoppedGeneratorProducesNothingThenStartsAndOvercomesDroop) {
  FleetConfig fleet = default_fleet();
  fleet.vessels[0].equipment[1].initial_state = EquipmentState::kStopped;
  fleet.vessels[0].equipment[1].auto_start_after_s = 10.0;
  Simulation sim(fleet, 42, kStartTime);
  EXPECT_EQ(truth(sim, kVessel, "GEN1", "power_output"), 0.0);
  EXPECT_EQ(truth(sim, kVessel, "GEN1", "frequency"), 0.0);
  run_seconds(sim, 12);
  EXPECT_EQ(state_of(sim, kVessel, "GEN1"), EquipmentState::kStarting);
  EXPECT_GT(truth(sim, kVessel, "GEN1", "frequency"), 10.0);
  EXPECT_LT(truth(sim, kVessel, "GEN1", "frequency"), 45.0);
  run_seconds(sim, 60);
  EXPECT_EQ(state_of(sim, kVessel, "GEN1"), EquipmentState::kRunning);
  EXPECT_NEAR(truth(sim, kVessel, "GEN1", "frequency"), 49.9, 0.3);
  EXPECT_GT(truth(sim, kVessel, "GEN1", "power_output"), 250.0);
}

TEST(GeneratorStateMachine, OverloadMakesItDegraded) {
  FleetConfig fleet = default_fleet();
  // A demand profile that overshoots the nominal load band by far.
  auto& load = fleet.vessels[0].equipment[1].measurements[1];
  load.nominal_min = 85.0;
  load.nominal_max = 99.0;
  fleet.vessels[0].equipment[1].parameters["overload_margin_pct"] = 0.0;
  Simulation sim(fleet, 42, kStartTime);
  run_until(sim, [&] { return state_of(sim, kVessel, "GEN1") == EquipmentState::kDegraded; }, 2000);
  EXPECT_EQ(state_of(sim, kVessel, "GEN1"), EquipmentState::kDegraded);
}

TEST(CoolingStateMachine, StoppedCoolingStartsAndRunsThenDegradesOnPressureLoss) {
  FleetConfig fleet = default_fleet();
  fleet.vessels[0].equipment[2].initial_state = EquipmentState::kStopped;
  fleet.vessels[0].equipment[2].auto_start_after_s = 5.0;
  Simulation sim(fleet, 42, kStartTime);
  EXPECT_EQ(state_of(sim, kVessel, "COOL1"), EquipmentState::kStopped);
  EXPECT_EQ(truth(sim, kVessel, "COOL1", "pressure"), 0.0);
  run_seconds(sim, 6);
  // The pump is on, but the pressure is still building up: low pressure counts as DEGRADED.
  EXPECT_EQ(state_of(sim, kVessel, "COOL1"), EquipmentState::kDegraded);
  EXPECT_LT(truth(sim, kVessel, "COOL1", "pressure"), 1.8);
  run_seconds(sim, 60);
  EXPECT_EQ(state_of(sim, kVessel, "COOL1"), EquipmentState::kRunning);
  EXPECT_NEAR(truth(sim, kVessel, "COOL1", "pressure"), 2.6, 0.3);
  activate(sim, kVessel, "cooling_pressure_loss");
  run_seconds(sim, 90);
  EXPECT_EQ(state_of(sim, kVessel, "COOL1"), EquipmentState::kDegraded);
}

TEST(CoolingStateMachine, StoppedCoolingEventuallyTripsAHotRunningEngine) {
  FleetConfig fleet = default_fleet();
  fleet.vessels[0].equipment[2].initial_state = EquipmentState::kStopped;
  Simulation sim(fleet, 42, kStartTime);
  run_until(sim, [&] { return state_of(sim, kVessel, "ME1") == EquipmentState::kTripped; }, 1800);
  EXPECT_EQ(state_of(sim, kVessel, "ME1"), EquipmentState::kTripped);
}

TEST(BilgeStateMachine, PumpStartsAbove35AndStopsBelow12WithHysteresis) {
  Simulation sim = make_simulation();
  EXPECT_EQ(state_of(sim, kVessel, "BILGE1"), EquipmentState::kStandby);
  activate(sim, kVessel, "bilge_flooding");

  double level_at_pump_start = 0.0;
  run_until(
      sim,
      [&] {
        if (state_of(sim, kVessel, "BILGE1") == EquipmentState::kPumping) {
          level_at_pump_start = truth(sim, kVessel, "BILGE1", "water_level");
          return true;
        }
        return false;
      },
      300);
  EXPECT_GE(level_at_pump_start, 35.0);
  EXPECT_LT(level_at_pump_start, 40.0);

  // Let the level climb, then stop the flooding and watch the pump drain it.
  run_seconds(sim, 20);
  clear(sim, kVessel, "bilge_flooding");
  bool pumping_through_middle_range = false;
  double level_at_pump_stop = 0.0;
  run_until(
      sim,
      [&] {
        const double level = truth(sim, kVessel, "BILGE1", "water_level");
        const EquipmentState state = state_of(sim, kVessel, "BILGE1");
        if (level > 13.0 && level < 34.0 && state == EquipmentState::kPumping) {
          pumping_through_middle_range = true;
        }
        if (state == EquipmentState::kStandby) {
          level_at_pump_stop = level;
          return true;
        }
        return false;
      },
      600);
  EXPECT_TRUE(pumping_through_middle_range)
      << "hysteresis: the pump must keep running between 35 and 12 cm";
  EXPECT_EQ(state_of(sim, kVessel, "BILGE1"), EquipmentState::kStandby);
  EXPECT_LE(level_at_pump_stop, 12.0);
  EXPECT_GT(level_at_pump_stop, 10.5);
}

TEST(BilgeStateMachine, SustainedFloodingBeyondPumpCapacityIsDegraded) {
  Simulation sim = make_simulation();
  activate(sim, kVessel, "bilge_flooding");
  run_until(
      sim, [&] { return state_of(sim, kVessel, "BILGE1") == EquipmentState::kDegraded; }, 300);
  EXPECT_EQ(state_of(sim, kVessel, "BILGE1"), EquipmentState::kDegraded);
  EXPECT_LE(truth(sim, kVessel, "BILGE1", "water_level"), 120.0) << "the bilge well is finite";
}

TEST(BilgeStateMachine, ConfiguredPumpingStartsPumpingDownToTheStopLevel) {
  FleetConfig fleet = default_fleet();
  fleet.vessels[0].equipment[3].initial_state = EquipmentState::kPumping;
  Simulation sim(fleet, 42, kStartTime);
  EXPECT_EQ(state_of(sim, kVessel, "BILGE1"), EquipmentState::kPumping);
  run_until(sim, [&] { return state_of(sim, kVessel, "BILGE1") == EquipmentState::kStandby; }, 300);
  EXPECT_EQ(state_of(sim, kVessel, "BILGE1"), EquipmentState::kStandby);
}

TEST(StateChanges, AreRecordedWithVesselEquipmentAndSimTime) {
  Simulation sim = make_simulation();
  activate(sim, kVessel, "bilge_flooding");
  run_seconds(sim, 60);
  const auto changes = sim.take_state_changes();
  ASSERT_FALSE(changes.empty());
  EXPECT_EQ(changes[0].vessel_id, kVessel);
  EXPECT_EQ(changes[0].equipment_code, "BILGE1");
  EXPECT_EQ(changes[0].from, EquipmentState::kStandby);
  EXPECT_EQ(changes[0].to, EquipmentState::kPumping);
  EXPECT_GT(changes[0].at, kStartTime);
  EXPECT_TRUE(sim.take_state_changes().empty());
}

}  // namespace
}  // namespace seatrace::sim
