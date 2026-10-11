#pragma once

#include <open62541/types.h>

#include "core/measurement.hpp"

namespace seatrace::sim::opcua {

// Quality -> OPC UA StatusCode as defined by the information model contract:
//   kGood             Good
//   kUncertain        UncertainSensorNotAccurate (sensor recently recovered)
//   kBadSensorFailure BadSensorFailure
// Note: the OPC UA specification (and open62541) assigns 0x808C0000 to BadSensorFailure and
// 0x40930000 to UncertainSensorNotAccurate; see "Deviations" in docs/opc-ua-model.md.
UA_StatusCode to_status_code(Quality quality);

}  // namespace seatrace::sim::opcua
