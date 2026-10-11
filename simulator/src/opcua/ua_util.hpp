#pragma once

#include <open62541/types.h>

#include <string>
#include <string_view>

#include "core/sim_time.hpp"

namespace seatrace::sim::opcua {

// Non-owning views onto std::string / string_view memory. open62541 copies everything that is
// passed to its server API (node attributes, DataValues, NodeIds), so these are only valid for the
// duration of the call that receives them.
inline UA_String ua_view(std::string_view text) {
  UA_String s;
  s.length = text.size();
  s.data = reinterpret_cast<UA_Byte*>(const_cast<char*>(text.data()));
  return s;
}

// The identifier is viewed, not copied: it must stay alive while the NodeId is used. Binding a
// temporary would dangle, hence the deleted overload.
UA_NodeId ua_node_id(UA_UInt16 ns, std::string&& identifier) = delete;
inline UA_NodeId ua_node_id(UA_UInt16 ns, const std::string& identifier) {
  UA_NodeId id;
  UA_NodeId_init(&id);
  id.namespaceIndex = ns;
  id.identifierType = UA_NODEIDTYPE_STRING;
  id.identifier.string = ua_view(identifier);
  return id;
}

inline UA_QualifiedName ua_qualified_name(UA_UInt16 ns, std::string_view name) {
  return UA_QualifiedName{ns, ua_view(name)};
}

inline UA_LocalizedText ua_text(std::string_view text) {
  return UA_LocalizedText{ua_view("en"), ua_view(text)};
}

inline std::string to_std_string(const UA_String& s) {
  return std::string(reinterpret_cast<const char*>(s.data), s.length);
}

// SimTime (UTC, ms since the Unix epoch) -> OPC UA DateTime (100 ns ticks since 1601).
inline UA_DateTime to_ua_datetime(SimTime t) {
  return UA_DATETIME_UNIX_EPOCH + t.time_since_epoch().count() * UA_DATETIME_MSEC;
}

}  // namespace seatrace::sim::opcua
