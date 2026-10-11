#include "core/config.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <fstream>
#include <initializer_list>
#include <nlohmann/json.hpp>
#include <set>
#include <sstream>
#include <utility>

#include "core/scenario.hpp"

namespace seatrace::sim {

namespace {

using nlohmann::json;

constexpr std::size_t kMaxCodeLength = 32;

std::string join(const std::string& path, std::string_view key) {
  return path.empty() ? std::string(key) : path + "." + std::string(key);
}

std::string index_path(const std::string& path, std::size_t index) {
  return path + "[" + std::to_string(index) + "]";
}

[[noreturn]] void fail(const std::string& path, const std::string& message) {
  throw ConfigError(path + ": " + message);
}

const json& require_object(const json& value, const std::string& path) {
  if (!value.is_object()) fail(path, "expected an object");
  return value;
}

void check_keys(const json& object, std::initializer_list<std::string_view> allowed,
                const std::string& path) {
  for (const auto& [key, unused] : object.items()) {
    if (std::ranges::find(allowed, key) == allowed.end()) {
      std::string expected;
      for (const auto name : allowed)
        expected += (expected.empty() ? "" : ", ") + std::string(name);
      fail(join(path, key), "unknown key (allowed: " + expected + ")");
    }
  }
}

const json& require_key(const json& object, std::string_view key, const std::string& path) {
  const auto it = object.find(key);
  if (it == object.end()) fail(join(path, key), "missing required key");
  return *it;
}

std::string get_string(const json& object, std::string_view key, const std::string& path) {
  const json& value = require_key(object, key, path);
  if (!value.is_string() || value.get<std::string>().empty()) {
    fail(join(path, key), "expected a non-empty string");
  }
  return value.get<std::string>();
}

double get_number(const json& object, std::string_view key, const std::string& path) {
  const json& value = require_key(object, key, path);
  if (!value.is_number()) fail(join(path, key), "expected a number");
  return value.get<double>();
}

const json& get_array(const json& object, std::string_view key, const std::string& path) {
  const json& value = require_key(object, key, path);
  if (!value.is_array()) fail(join(path, key), "expected an array");
  return value;
}

void check_code(const std::string& code, const std::string& path) {
  const bool charset_ok = std::ranges::all_of(
      code, [](unsigned char c) { return std::isalnum(c) != 0 || c == '-' || c == '_'; });
  if (code.size() > kMaxCodeLength || !charset_ok) {
    fail(path, "code '" + code + "' must consist of letters, digits, '-' and '_' (max " +
                   std::to_string(kMaxCodeLength) + " characters); '.' is the NodeId separator");
  }
}

ParamValues parse_param_map(const json& object, std::string_view key, const std::string& path) {
  ParamValues values;
  const auto it = object.find(key);
  if (it == object.end()) return values;
  const std::string group_path = join(path, key);
  require_object(*it, group_path);
  for (const auto& [name, value] : it->items()) {
    if (!value.is_number()) fail(join(group_path, name), "expected a number");
    values[name] = value.get<double>();
  }
  return values;
}

MeasurementSpec parse_measurement(const json& node, const MeasurementTemplate& tmpl,
                                  const std::string& path) {
  check_keys(node,
             {"name", "unit", "nominal_min", "nominal_max", "plausible_min", "plausible_max",
              "noise_sigma"},
             path);
  MeasurementSpec spec;
  spec.name = std::string(tmpl.name);
  spec.key = std::string(tmpl.key);
  spec.unit = get_string(node, "unit", path);
  if (spec.unit != tmpl.unit) {
    fail(join(path, "unit"), "unit of " + spec.name + " must be '" + std::string(tmpl.unit) +
                                 "' (fixed by the OPC UA model), got '" + spec.unit + "'");
  }
  spec.nominal_min = get_number(node, "nominal_min", path);
  spec.nominal_max = get_number(node, "nominal_max", path);
  spec.plausible_min = get_number(node, "plausible_min", path);
  spec.plausible_max = get_number(node, "plausible_max", path);
  spec.noise_sigma = get_number(node, "noise_sigma", path);
  if (spec.nominal_min > spec.nominal_max) {
    fail(path, "nominal_min (" + std::to_string(spec.nominal_min) +
                   ") is greater than nominal_max (" + std::to_string(spec.nominal_max) + ")");
  }
  if (spec.plausible_min >= spec.plausible_max) {
    fail(path, "plausible_min must be less than plausible_max");
  }
  if (spec.nominal_min < spec.plausible_min || spec.nominal_max > spec.plausible_max) {
    fail(path, "the nominal range must lie within the plausible range");
  }
  if (spec.noise_sigma < 0.0) fail(join(path, "noise_sigma"), "must not be negative");
  return spec;
}

std::vector<MeasurementSpec> parse_measurements(const json& equipment, EquipmentType type,
                                                const std::string& path) {
  const json& array = get_array(equipment, "measurements", path);
  const std::string array_path = join(path, "measurements");
  std::vector<const json*> by_template(measurement_templates(type).size(), nullptr);
  std::vector<std::string> by_template_path(by_template.size());
  for (std::size_t i = 0; i < array.size(); ++i) {
    const std::string item_path = index_path(array_path, i);
    require_object(array[i], item_path);
    const std::string name = get_string(array[i], "name", item_path);
    const auto templates = measurement_templates(type);
    const auto it = std::ranges::find(templates, name, &MeasurementTemplate::name);
    if (it == templates.end()) {
      std::string allowed;
      for (const auto& t : templates) {
        if (!allowed.empty()) allowed += ", ";
        allowed += t.name;
      }
      fail(item_path, "unknown measurement '" + name + "' for " + std::string(to_string(type)) +
                          " (allowed: " + allowed + ")");
    }
    const auto slot = static_cast<std::size_t>(it - templates.begin());
    if (by_template[slot] != nullptr) fail(item_path, "duplicate measurement '" + name + "'");
    by_template[slot] = &array[i];
    by_template_path[slot] = item_path;
  }
  std::vector<MeasurementSpec> specs;
  const auto templates = measurement_templates(type);
  for (std::size_t slot = 0; slot < templates.size(); ++slot) {
    if (by_template[slot] == nullptr) {
      fail(array_path, "missing measurement '" + std::string(templates[slot].name) +
                           "' required by " + std::string(to_string(type)));
    }
    specs.push_back(parse_measurement(*by_template[slot], templates[slot], by_template_path[slot]));
  }
  return specs;
}

EquipmentConfig parse_equipment(const json& node, const std::string& path) {
  require_object(node, path);
  check_keys(node,
             {"code", "name", "type", "initial_state", "auto_start_after_s", "rated", "parameters",
              "measurements"},
             path);
  EquipmentConfig equipment;
  equipment.code = get_string(node, "code", path);
  check_code(equipment.code, join(path, "code"));
  equipment.name = get_string(node, "name", path);

  const std::string type_name = get_string(node, "type", path);
  const auto type = parse_equipment_type(type_name);
  if (!type) {
    fail(join(path, "type"), "unknown equipment type '" + type_name +
                                 "' (allowed: MainEngine, Generator, CoolingSystem, BilgeSystem)");
  }
  equipment.type = *type;
  equipment.initial_state =
      *type == EquipmentType::kBilgeSystem ? EquipmentState::kStandby : EquipmentState::kRunning;
  if (node.contains("initial_state")) {
    const std::string state_name = get_string(node, "initial_state", path);
    const auto state = parse_equipment_state(state_name);
    if (!state || !is_valid_initial_state(*type, *state)) {
      fail(join(path, "initial_state"),
           "'" + state_name + "' is not a valid initial state for " + type_name);
    }
    equipment.initial_state = *state;
  }
  if (node.contains("auto_start_after_s")) {
    const double delay = get_number(node, "auto_start_after_s", path);
    if (delay < 0.0) fail(join(path, "auto_start_after_s"), "must not be negative");
    equipment.auto_start_after_s = delay;
  }
  equipment.rated = parse_param_map(node, "rated", path);
  equipment.parameters = parse_param_map(node, "parameters", path);
  try {
    const ParamSet validated(*type, equipment.rated, equipment.parameters);
  } catch (const ConfigError& error) {
    fail(path, error.what());
  }
  equipment.measurements = parse_measurements(node, *type, path);
  return equipment;
}

std::vector<InitialScenario> parse_initial_scenarios(const json& node, const VesselConfig& vessel,
                                                     const std::string& path) {
  std::vector<InitialScenario> scenarios;
  const auto it = node.find("initial_scenarios");
  if (it == node.end()) return scenarios;
  const std::string array_path = join(path, "initial_scenarios");
  if (!it->is_array()) fail(array_path, "expected an array");
  std::set<std::string> seen;
  for (std::size_t i = 0; i < it->size(); ++i) {
    const std::string item_path = index_path(array_path, i);
    const json& item = require_object((*it)[i], item_path);
    check_keys(item, {"scenario_id", "duration_seconds"}, item_path);
    InitialScenario scenario;
    scenario.scenario_id = get_string(item, "scenario_id", item_path);
    const ScenarioDef* def = find_scenario(scenario.scenario_id);
    if (def == nullptr) {
      fail(join(item_path, "scenario_id"), "unknown scenario id '" + scenario.scenario_id + "'");
    }
    if (def->scope == ScenarioScope::kServer) {
      fail(join(item_path, "scenario_id"),
           "server-wide scenario '" + scenario.scenario_id + "' cannot be an initial scenario");
    }
    const bool has_target = def->target_equipment.empty() ||
                            std::ranges::any_of(vessel.equipment, [&](const EquipmentConfig& e) {
                              return e.code == def->target_equipment;
                            });
    if (!has_target) {
      fail(join(item_path, "scenario_id"), "scenario '" + scenario.scenario_id + "' targets " +
                                               std::string(def->target_equipment) +
                                               ", which this vessel does not have");
    }
    if (!seen.insert(scenario.scenario_id).second) {
      fail(item_path, "duplicate initial scenario '" + scenario.scenario_id + "'");
    }
    if (item.contains("duration_seconds")) {
      const double seconds = get_number(item, "duration_seconds", item_path);
      if (seconds < 0.0 || seconds != std::floor(seconds) || seconds > 4294967295.0) {
        fail(join(item_path, "duration_seconds"), "expected a non-negative integer");
      }
      scenario.duration_seconds = static_cast<std::uint32_t>(seconds);
    }
    scenarios.push_back(std::move(scenario));
  }
  return scenarios;
}

VesselConfig parse_vessel(const json& node, const std::string& path) {
  require_object(node, path);
  check_keys(node, {"code", "name", "description", "equipment", "initial_scenarios"}, path);
  VesselConfig vessel;
  vessel.code = get_string(node, "code", path);
  check_code(vessel.code, join(path, "code"));
  vessel.name = get_string(node, "name", path);

  const json& equipment = get_array(node, "equipment", path);
  const std::string equipment_path = join(path, "equipment");
  if (equipment.empty()) fail(equipment_path, "a vessel needs at least one equipment");
  std::set<std::string> codes;
  for (std::size_t i = 0; i < equipment.size(); ++i) {
    vessel.equipment.push_back(parse_equipment(equipment[i], index_path(equipment_path, i)));
    if (!codes.insert(vessel.equipment.back().code).second) {
      fail(index_path(equipment_path, i) + ".code", "duplicate equipment code '" +
                                                        vessel.equipment.back().code +
                                                        "' in vessel " + vessel.code);
    }
  }
  vessel.initial_scenarios = parse_initial_scenarios(node, vessel, path);
  return vessel;
}

}  // namespace

const MeasurementSpec& EquipmentConfig::measurement(std::string_view key) const {
  const auto it = std::ranges::find(measurements, key, &MeasurementSpec::key);
  if (it == measurements.end()) {
    throw std::out_of_range("equipment " + code + " has no measurement " + std::string(key));
  }
  return *it;
}

FleetConfig parse_fleet_config(std::string_view json_text) {
  json document;
  try {
    document = json::parse(json_text);
  } catch (const json::parse_error& error) {
    throw ConfigError(std::string("invalid JSON: ") + error.what());
  }
  const std::string root = "$";
  require_object(document, root);
  check_keys(document, {"schema_version", "description", "vessels"}, root);
  if (document.contains("schema_version") && document["schema_version"] != 1) {
    fail("schema_version", "unsupported schema version (this build understands 1)");
  }

  FleetConfig fleet;
  const json& vessels = get_array(document, "vessels", root);
  if (vessels.empty()) fail("vessels", "at least one vessel is required");
  std::set<std::string> codes;
  for (std::size_t i = 0; i < vessels.size(); ++i) {
    fleet.vessels.push_back(parse_vessel(vessels[i], index_path("vessels", i)));
    if (!codes.insert(fleet.vessels.back().code).second) {
      fail(index_path("vessels", i) + ".code",
           "duplicate vessel code '" + fleet.vessels.back().code + "'");
    }
  }
  return fleet;
}

FleetConfig load_fleet_config(const std::filesystem::path& path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) throw ConfigError("cannot open fleet config '" + path.string() + "'");
  std::ostringstream content;
  content << file.rdbuf();
  try {
    return parse_fleet_config(content.str());
  } catch (const ConfigError& error) {
    throw ConfigError(path.string() + ": " + error.what());
  }
}

}  // namespace seatrace::sim
