#include "opcua/address_space.hpp"

#include <open62541/statuscodes.h>

#include <stdexcept>

#include "opcua/status_mapping.hpp"
#include "opcua/ua_util.hpp"

namespace seatrace::sim::opcua {

namespace {

void check(UA_StatusCode status, std::string_view what) {
  if (status != UA_STATUSCODE_GOOD) {
    throw std::runtime_error("address space: " + std::string(what) + ": " +
                             UA_StatusCode_name(status));
  }
}

UA_NodeId ns0(UA_UInt32 identifier) { return UA_NODEID_NUMERIC(0, identifier); }

}  // namespace

AddressSpace::AddressSpace(UA_Server* server, const Simulation& simulation, ControlContext& control)
    : server_(server), ns_(UA_Server_addNamespace(server, std::string(kNamespaceUri).c_str())) {
  build(simulation, control);
}

void AddressSpace::add_object(const UA_NodeId& parent, UA_UInt32 reference_type,
                              const std::string& id, std::string_view browse_name,
                              std::string_view display_name) {
  UA_ObjectAttributes attributes = UA_ObjectAttributes_default;
  attributes.displayName = ua_text(display_name);
  check(UA_Server_addObjectNode(server_, ua_node_id(ns_, id), parent, ns0(reference_type),
                                ua_qualified_name(ns_, browse_name), ns0(UA_NS0ID_BASEOBJECTTYPE),
                                attributes, nullptr, nullptr),
        "add object " + id);
}

void AddressSpace::add_variable_node(const UA_NodeId& parent, UA_UInt32 reference_type,
                                     UA_UInt32 type_definition, const std::string& id,
                                     std::string_view browse_name, const UA_DataType& type,
                                     const void* initial, std::string_view description) {
  UA_VariableAttributes attributes = UA_VariableAttributes_default;
  UA_Variant_setScalar(&attributes.value, const_cast<void*>(initial), &type);
  attributes.dataType = type.typeId;
  attributes.valueRank = UA_VALUERANK_SCALAR;
  attributes.accessLevel = UA_ACCESSLEVELMASK_READ;
  attributes.displayName = ua_text(browse_name);
  attributes.description = ua_text(description);
  check(UA_Server_addVariableNode(server_, ua_node_id(ns_, id), parent, ns0(reference_type),
                                  ua_qualified_name(ns_, browse_name), ns0(type_definition),
                                  attributes, nullptr, nullptr),
        "add variable " + id);
}

void AddressSpace::add_property(const UA_NodeId& parent, const std::string& id,
                                std::string_view browse_name, std::string_view value) {
  const UA_String text = ua_view(value);
  add_variable_node(parent, UA_NS0ID_HASPROPERTY, UA_NS0ID_PROPERTYTYPE, id, browse_name,
                    UA_TYPES[UA_TYPES_STRING], &text, browse_name);
}

void AddressSpace::add_variable(const UA_NodeId& parent, const std::string& id,
                                std::string_view browse_name, const UA_DataType& type,
                                std::string_view description) {
  // Zero-initialised storage large enough for every type used here (String, Double, UInt64).
  alignas(8) unsigned char initial[16] = {};
  add_variable_node(parent, UA_NS0ID_HASCOMPONENT, UA_NS0ID_BASEDATAVARIABLETYPE, id, browse_name,
                    type, initial, description);
  // Until the first snapshot is published there is no data; say so instead of a fake Good zero.
  write(id, type, initial, UA_STATUSCODE_BADWAITINGFORINITIALDATA, std::nullopt);
}

void AddressSpace::build(const Simulation& simulation, ControlContext& control) {
  const std::string root_id = "SeaTrace";
  const std::string simulator_id = "Simulator";
  const std::string vessels_id = "Vessels";
  add_object(ns0(UA_NS0ID_OBJECTSFOLDER), UA_NS0ID_ORGANIZES, root_id, "SeaTrace", "SeaTrace");
  const UA_NodeId root = ua_node_id(ns_, root_id);

  // --- Simulator control/diagnostic object ---
  add_object(root, UA_NS0ID_ORGANIZES, simulator_id, "Simulator", "Simulator");
  const UA_NodeId simulator = ua_node_id(ns_, simulator_id);
  add_property(simulator, "Simulator.Notice", "Notice", kNotice);
  const UA_UInt32 seed = simulation.seed();
  add_variable_node(simulator, UA_NS0ID_HASPROPERTY, UA_NS0ID_PROPERTYTYPE, "Simulator.Seed",
                    "Seed", UA_TYPES[UA_TYPES_UINT32], &seed, "Random seed of this run");
  add_variable(simulator, "Simulator.Heartbeat", "Heartbeat", UA_TYPES[UA_TYPES_UINT64],
               "Increments every simulation tick, also during telemetry interruptions");
  add_variable(simulator, "Simulator.ActiveScenarios", "ActiveScenarios", UA_TYPES[UA_TYPES_STRING],
               "JSON array of the active scenarios");
  check(add_control_methods(server_, ns_, simulator, control), "add control methods");

  // --- Vessels ---
  add_object(root, UA_NS0ID_ORGANIZES, vessels_id, "Vessels", "Vessels");
  for (const auto& vessel : simulation.vessels()) add_vessel(*vessel);

  publish(simulation);
}

void AddressSpace::add_vessel(const Vessel& vessel) {
  const std::string vessel_id = vessel.code();
  const std::string vessels_id = "Vessels";
  add_object(ua_node_id(ns_, vessels_id), UA_NS0ID_ORGANIZES, vessel_id, vessel_id, vessel.name());
  const UA_NodeId vessel_node = ua_node_id(ns_, vessel_id);
  add_property(vessel_node, vessel_id + ".VesselId", "VesselId", vessel_id);
  add_property(vessel_node, vessel_id + ".Name", "Name", vessel.name());

  VesselNodes nodes{&vessel, {}};
  for (const auto& equipment : vessel.equipment()) {
    add_equipment(vessel_node, vessel, *equipment, nodes);
  }
  vessels_.push_back(std::move(nodes));
}

void AddressSpace::add_equipment(const UA_NodeId& vessel_node, const Vessel& vessel,
                                 const Equipment& equipment, VesselNodes& nodes) {
  const std::string equipment_id = vessel.code() + "." + equipment.code();
  add_object(vessel_node, UA_NS0ID_HASCOMPONENT, equipment_id, equipment.code(), equipment.name());
  const UA_NodeId equipment_node = ua_node_id(ns_, equipment_id);
  add_property(equipment_node, equipment_id + ".EquipmentType", "EquipmentType",
               to_string(equipment.type()));

  EquipmentNodes equipment_nodes{
      &equipment, equipment_id + ".State", equipment_id + ".SensorHealth", {}};
  add_variable(equipment_node, equipment_nodes.state_id, "State", UA_TYPES[UA_TYPES_STRING],
               "Operating state of the equipment");
  add_variable(equipment_node, equipment_nodes.health_id, "SensorHealth", UA_TYPES[UA_TYPES_STRING],
               "Diagnostic summary of the equipment's sensors: OK, DEGRADED or FAULT");
  for (const Sensor& sensor : equipment.sensors()) {
    const MeasurementSpec& spec = sensor.spec();
    const std::string measurement_id = equipment_id + "." + spec.name;
    add_variable(equipment_node, measurement_id, spec.name, UA_TYPES[UA_TYPES_DOUBLE],
                 "Simulated " + spec.key + " in " + spec.unit);
    add_property(ua_node_id(ns_, measurement_id), measurement_id + ".Unit", "Unit", spec.unit);
    equipment_nodes.measurement_ids.push_back(measurement_id);
  }
  nodes.equipment.push_back(std::move(equipment_nodes));
}

bool AddressSpace::write(const std::string& id, const UA_DataType& type, const void* value,
                         UA_StatusCode status, std::optional<SimTime> source_time) {
  UA_DataValue data;
  UA_DataValue_init(&data);
  UA_Variant_setScalar(&data.value, const_cast<void*>(value), &type);
  data.hasValue = true;
  data.hasStatus = status != UA_STATUSCODE_GOOD;
  data.status = status;
  if (source_time) {
    data.hasSourceTimestamp = true;
    data.sourceTimestamp = to_ua_datetime(*source_time);
  }
  data.hasServerTimestamp = true;
  data.serverTimestamp = UA_DateTime_now();
  return UA_Server_writeDataValue(server_, ua_node_id(ns_, id), data) == UA_STATUSCODE_GOOD;
}

bool AddressSpace::write_string(const std::string& id, std::string_view value,
                                SimTime source_time) {
  const UA_String text = ua_view(value);
  return write(id, UA_TYPES[UA_TYPES_STRING], &text, UA_STATUSCODE_GOOD, source_time);
}

std::size_t AddressSpace::publish(const Simulation& simulation) {
  std::size_t failures = 0;
  const SimTime now = simulation.now();

  for (const VesselNodes& vessel : vessels_) {
    // Telemetry interruption: neither values nor source timestamps are written, so a client sees
    // the last values with a frozen SourceTimestamp while the server stays up.
    if (vessel.vessel->telemetry_interrupted()) continue;
    for (const EquipmentNodes& equipment : vessel.equipment) {
      failures +=
          write_string(equipment.state_id, to_string(equipment.equipment->state()), now) ? 0 : 1;
      failures +=
          write_string(equipment.health_id, to_string(equipment.equipment->sensor_health()), now)
              ? 0
              : 1;
      const auto& sensors = equipment.equipment->sensors();
      for (std::size_t i = 0; i < sensors.size(); ++i) {
        const Reading& reading = sensors[i].reading();
        failures += write(equipment.measurement_ids[i], UA_TYPES[UA_TYPES_DOUBLE], &reading.value,
                          to_status_code(reading.quality), now)
                        ? 0
                        : 1;
      }
    }
  }

  const UA_UInt64 heartbeat = simulation.heartbeat();
  failures +=
      write("Simulator.Heartbeat", UA_TYPES[UA_TYPES_UINT64], &heartbeat, UA_STATUSCODE_GOOD, now)
          ? 0
          : 1;
  return failures + publish_scenarios(simulation);
}

std::size_t AddressSpace::publish_scenarios(const Simulation& simulation) {
  const std::string json = simulation.scenarios().active_json();
  if (json == last_scenarios_json_) return 0;
  if (!write_string("Simulator.ActiveScenarios", json, simulation.now())) return 1;
  last_scenarios_json_ = json;
  return 0;
}

}  // namespace seatrace::sim::opcua
