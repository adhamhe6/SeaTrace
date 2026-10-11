#include "opcua/status_mapping.hpp"

#include <open62541/statuscodes.h>

namespace seatrace::sim::opcua {

UA_StatusCode to_status_code(Quality quality) {
  switch (quality) {
    case Quality::kGood:
      return UA_STATUSCODE_GOOD;
    case Quality::kUncertain:
      return UA_STATUSCODE_UNCERTAINSENSORNOTACCURATE;
    case Quality::kBadSensorFailure:
      return UA_STATUSCODE_BADSENSORFAILURE;
  }
  return UA_STATUSCODE_BADINTERNALERROR;
}

}  // namespace seatrace::sim::opcua
