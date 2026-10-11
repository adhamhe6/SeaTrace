#include "core/config.hpp"

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include <fstream>
#include <functional>
#include <nlohmann/json.hpp>
#include <sstream>

#include "test_support.hpp"

namespace seatrace::sim {
namespace {

using nlohmann::json;

json default_document() {
  std::ifstream file(SEATRACE_FLEET_CONFIG);
  std::stringstream text;
  text << file.rdbuf();
  return json::parse(text.str());
}

// Applies `mutate` to the default configuration and returns the ConfigError message, or "" when
// the configuration was accepted.
std::string error_for(const std::function<void(json&)>& mutate) {
  json document = default_document();
  mutate(document);
  try {
    parse_fleet_config(document.dump());
  } catch (const ConfigError& error) {
    return error.what();
  }
  return "";
}

MATCHER_P(ErrorMentions, text, "") {
  *result_listener << "error was: \"" << arg << "\"";
  return arg.find(text) != std::string::npos;
}

json& equipment(json& document, int vessel, int index) {
  return document["vessels"][vessel]["equipment"][index];
}
json& measurement(json& document, int vessel, int equipment_index, int index) {
  return equipment(document, vessel, equipment_index)["measurements"][index];
}

TEST(FleetConfig, DefaultFileLoadsWithTheDocumentedInventory) {
  const FleetConfig fleet = testing::default_fleet();
  ASSERT_EQ(fleet.vessels.size(), 2U);
  EXPECT_EQ(fleet.vessels[0].code, "VES-001");
  EXPECT_EQ(fleet.vessels[0].name, "MV Aurora Tide");
  EXPECT_EQ(fleet.vessels[1].code, "VES-002");
  EXPECT_EQ(fleet.vessels[1].name, "MV Baltic Meridian");
  for (const VesselConfig& vessel : fleet.vessels) {
    ASSERT_EQ(vessel.equipment.size(), 4U);
    EXPECT_EQ(vessel.equipment[0].code, "ME1");
    EXPECT_EQ(vessel.equipment[0].type, EquipmentType::kMainEngine);
    EXPECT_EQ(vessel.equipment[1].code, "GEN1");
    EXPECT_EQ(vessel.equipment[1].type, EquipmentType::kGenerator);
    EXPECT_EQ(vessel.equipment[2].code, "COOL1");
    EXPECT_EQ(vessel.equipment[2].type, EquipmentType::kCoolingSystem);
    EXPECT_EQ(vessel.equipment[3].code, "BILGE1");
    EXPECT_EQ(vessel.equipment[3].type, EquipmentType::kBilgeSystem);
    EXPECT_TRUE(vessel.initial_scenarios.empty());
  }
}

TEST(FleetConfig, MeasurementsFollowTheContractUnitsAndOrder) {
  const FleetConfig fleet = testing::default_fleet();
  const auto& me = fleet.vessels[0].equipment[0];
  ASSERT_EQ(me.measurements.size(), 4U);
  const std::vector<std::pair<std::string, std::string>> expected{
      {"Rpm", "rpm"}, {"Temperature", "°C"}, {"Vibration", "mm/s"}, {"Load", "%"}};
  for (std::size_t i = 0; i < expected.size(); ++i) {
    EXPECT_EQ(me.measurements[i].name, expected[i].first);
    EXPECT_EQ(me.measurements[i].unit, expected[i].second);
  }
  EXPECT_EQ(me.measurement("temperature").nominal_min, 78.0);
  EXPECT_EQ(me.measurement("temperature").nominal_max, 88.0);
  EXPECT_EQ(fleet.vessels[0].equipment[1].measurements[0].key, "power_output");
  EXPECT_EQ(fleet.vessels[0].equipment[1].measurements[0].unit, "kW");
  EXPECT_EQ(fleet.vessels[0].equipment[2].measurements[0].unit, "bar");
  EXPECT_EQ(fleet.vessels[0].equipment[3].measurements[0].key, "water_level");
  EXPECT_EQ(fleet.vessels[0].equipment[3].measurements[0].unit, "cm");
}

TEST(FleetConfig, VesselsDifferInParameters) {
  const FleetConfig fleet = testing::default_fleet();
  EXPECT_NE(fleet.vessels[0].equipment[1].rated.at("power_kw"),
            fleet.vessels[1].equipment[1].rated.at("power_kw"));
  EXPECT_NE(fleet.vessels[0].equipment[0].parameters.at("load_period_s"),
            fleet.vessels[1].equipment[0].parameters.at("load_period_s"));
}

TEST(FleetConfig, RejectsInvalidJson) {
  try {
    parse_fleet_config("{ not json");
    FAIL() << "expected ConfigError";
  } catch (const ConfigError& error) {
    EXPECT_THAT(std::string(error.what()), ErrorMentions("invalid JSON"));
  }
}

TEST(FleetConfig, RejectsMissingFile) {
  EXPECT_THROW(load_fleet_config("/nonexistent/fleet.json"), ConfigError);
}

TEST(FleetConfig, RejectsDuplicateVesselCodes) {
  EXPECT_THAT(error_for([](json& d) { d["vessels"][1]["code"] = "VES-001"; }),
              ErrorMentions("duplicate vessel code 'VES-001'"));
}

TEST(FleetConfig, RejectsDuplicateEquipmentCodes) {
  EXPECT_THAT(error_for([](json& d) { equipment(d, 0, 1)["code"] = "ME1"; }),
              ErrorMentions("duplicate equipment code 'ME1'"));
}

TEST(FleetConfig, RejectsCodesThatBreakNodeIds) {
  EXPECT_THAT(error_for([](json& d) { equipment(d, 0, 0)["code"] = "ME.1"; }),
              ErrorMentions("NodeId separator"));
  EXPECT_THAT(error_for([](json& d) { d["vessels"][0]["code"] = ""; }),
              ErrorMentions("non-empty string"));
}

TEST(FleetConfig, RejectsNominalMinGreaterThanNominalMax) {
  const std::string message = error_for([](json& d) {
    measurement(d, 0, 0, 1)["nominal_min"] = 95.0;  // ME1 temperature, nominal_max is 88
  });
  EXPECT_THAT(message, ErrorMentions("nominal_min"));
  EXPECT_THAT(message, ErrorMentions("vessels[0].equipment[0].measurements[1]"));
}

TEST(FleetConfig, RejectsNominalRangeOutsidePlausibleRange) {
  EXPECT_THAT(error_for([](json& d) { measurement(d, 0, 0, 1)["plausible_max"] = 85.0; }),
              ErrorMentions("nominal range must lie within the plausible range"));
}

TEST(FleetConfig, RejectsInvertedPlausibleRangeAndNegativeNoise) {
  EXPECT_THAT(error_for([](json& d) {
                measurement(d, 0, 0, 1)["plausible_min"] = 300.0;
                measurement(d, 0, 0, 1)["plausible_max"] = 100.0;
              }),
              ErrorMentions("plausible_min must be less than plausible_max"));
  EXPECT_THAT(error_for([](json& d) { measurement(d, 0, 0, 1)["noise_sigma"] = -1.0; }),
              ErrorMentions("noise_sigma"));
}

TEST(FleetConfig, RejectsUnknownEquipmentType) {
  EXPECT_THAT(error_for([](json& d) { equipment(d, 0, 0)["type"] = "Thruster"; }),
              ErrorMentions("unknown equipment type 'Thruster'"));
}

TEST(FleetConfig, RejectsUnknownScenarioInInitialScenarios) {
  EXPECT_THAT(error_for([](json& d) {
                d["vessels"][0]["initial_scenarios"] = json::array({{{"scenario_id", "meteor"}}});
              }),
              ErrorMentions("unknown scenario id 'meteor'"));
}

TEST(FleetConfig, RejectsInitialScenarioWhoseTargetDoesNotExist) {
  EXPECT_THAT(error_for([](json& d) {
                d["vessels"][0]["equipment"].erase(3);  // no BILGE1
                d["vessels"][0]["initial_scenarios"] =
                    json::array({{{"scenario_id", "bilge_flooding"}}});
              }),
              ErrorMentions("does not have"));
}

TEST(FleetConfig, RejectsServerWideAndDuplicateInitialScenarios) {
  EXPECT_THAT(error_for([](json& d) {
                d["vessels"][0]["initial_scenarios"] =
                    json::array({{{"scenario_id", "opcua_outage"}}});
              }),
              ErrorMentions("cannot be an initial scenario"));
  EXPECT_THAT(error_for([](json& d) {
                d["vessels"][0]["initial_scenarios"] = json::array(
                    {{{"scenario_id", "sensor_stuck"}}, {{"scenario_id", "sensor_stuck"}}});
              }),
              ErrorMentions("duplicate initial scenario"));
}

TEST(FleetConfig, AcceptsValidInitialScenarioAndInitialState) {
  json document = default_document();
  document["vessels"][0]["initial_scenarios"] =
      json::array({{{"scenario_id", "sensor_failure"}, {"duration_seconds", 30}}});
  equipment(document, 0, 0)["initial_state"] = "STOPPED";
  const FleetConfig fleet = parse_fleet_config(document.dump());
  ASSERT_EQ(fleet.vessels[0].initial_scenarios.size(), 1U);
  EXPECT_EQ(fleet.vessels[0].initial_scenarios[0].duration_seconds, 30U);
  EXPECT_EQ(fleet.vessels[0].equipment[0].initial_state, EquipmentState::kStopped);
}

TEST(FleetConfig, RejectsInitialStatesThatAreNotConfigurable) {
  EXPECT_THAT(error_for([](json& d) { equipment(d, 0, 0)["initial_state"] = "TRIPPED"; }),
              ErrorMentions("not a valid initial state"));
  EXPECT_THAT(error_for([](json& d) { equipment(d, 0, 3)["initial_state"] = "RUNNING"; }),
              ErrorMentions("not a valid initial state"));
}

TEST(FleetConfig, RejectsWrongUnit) {
  EXPECT_THAT(error_for([](json& d) { measurement(d, 0, 0, 1)["unit"] = "K"; }),
              ErrorMentions("unit of Temperature must be"));
}

TEST(FleetConfig, RejectsMissingAndUnknownMeasurements) {
  EXPECT_THAT(error_for([](json& d) { equipment(d, 0, 0)["measurements"].erase(0); }),
              ErrorMentions("missing measurement 'Rpm'"));
  EXPECT_THAT(error_for([](json& d) { measurement(d, 0, 0, 0)["name"] = "Torque"; }),
              ErrorMentions("unknown measurement 'Torque'"));
  EXPECT_THAT(error_for([](json& d) { measurement(d, 0, 0, 0)["name"] = "Load"; }),
              ErrorMentions("duplicate measurement 'Load'"));
}

TEST(FleetConfig, RejectsUnknownKeysAndBadParameters) {
  EXPECT_THAT(error_for([](json& d) { d["vessels"][0]["colour"] = "blue"; }),
              ErrorMentions("vessels[0].colour: unknown key"));
  EXPECT_THAT(error_for([](json& d) { equipment(d, 0, 0)["parameters"]["turbo"] = 1.0; }),
              ErrorMentions("parameters.turbo: unknown key"));
  EXPECT_THAT(error_for([](json& d) { equipment(d, 0, 0)["rated"]["trip_temperature_c"] = 500.0; }),
              ErrorMentions("outside the accepted range"));
  EXPECT_THAT(error_for([](json& d) {
                equipment(d, 0, 3)["rated"]["pump_stop_level_cm"] = 40.0;  // above the start level
              }),
              ErrorMentions("pump_stop_level_cm must be below"));
}

TEST(FleetConfig, RejectsEmptyFleetAndWrongSchemaVersion) {
  EXPECT_THAT(error_for([](json& d) { d["vessels"] = json::array(); }),
              ErrorMentions("at least one vessel"));
  EXPECT_THAT(error_for([](json& d) { d["schema_version"] = 2; }),
              ErrorMentions("unsupported schema version"));
  EXPECT_THAT(error_for([](json& d) { d.erase("vessels"); }),
              ErrorMentions("missing required key"));
}

}  // namespace
}  // namespace seatrace::sim
