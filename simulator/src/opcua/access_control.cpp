#include "opcua/access_control.hpp"

#include <open62541/plugin/accesscontrol_default.h>

#include <algorithm>

#include "opcua/ua_util.hpp"

namespace seatrace::sim::opcua {

namespace {

// Only the address of this object matters.
char g_control_session_marker = 'C';

UA_StatusCode login_trampoline(const UA_String* user_name, const UA_ByteString* password,
                               size_t /*logins_size*/, const UA_UsernamePasswordLogin* /*logins*/,
                               void** session_context, void* login_context) {
  const auto* authenticator = static_cast<const ControlAuthenticator*>(login_context);
  return authenticator->authenticate(to_std_string(*user_name), to_std_string(*password),
                                     session_context);
}

UA_Boolean method_executable_by(UA_Server* /*server*/, UA_AccessControl* /*ac*/,
                                const UA_NodeId* /*session_id*/, void* session_context,
                                const UA_NodeId* method_id, void* /*method_context*/) {
  // Reflects the UserExecutable attribute: the control methods are executable by the control
  // account only; the built-in namespace 0 methods stay available to everyone.
  if (method_id->namespaceIndex == 0) return true;
  return is_control_session(session_context);
}

UA_Boolean allow_call(UA_Server* /*server*/, UA_AccessControl* /*ac*/,
                      const UA_NodeId* /*session_id*/, void* /*session_context*/,
                      const UA_NodeId* /*method_id*/, void* /*method_context*/,
                      const UA_NodeId* /*object_id*/, void* /*object_context*/) {
  // Let every call reach the handler, which rejects non-control sessions with
  // BadUserAccessDenied (this generic gate would answer BadNotExecutable instead).
  return true;
}

UA_Boolean deny_add_node(UA_Server*, UA_AccessControl*, const UA_NodeId*, void*,
                         const UA_AddNodesItem*) {
  return false;
}
UA_Boolean deny_add_reference(UA_Server*, UA_AccessControl*, const UA_NodeId*, void*,
                              const UA_AddReferencesItem*) {
  return false;
}
UA_Boolean deny_delete_node(UA_Server*, UA_AccessControl*, const UA_NodeId*, void*,
                            const UA_DeleteNodesItem*) {
  return false;
}
UA_Boolean deny_delete_reference(UA_Server*, UA_AccessControl*, const UA_NodeId*, void*,
                                 const UA_DeleteReferencesItem*) {
  return false;
}

}  // namespace

bool is_control_session(const void* session_context) {
  return session_context == &g_control_session_marker;
}

bool constant_time_equal(std::string_view a, std::string_view b) {
  unsigned diff = a.size() == b.size() ? 0U : 1U;
  const std::size_t length = std::max(a.size(), b.size());
  for (std::size_t i = 0; i < length; ++i) {
    const auto ca = static_cast<unsigned char>(i < a.size() ? a[i] : 0);
    const auto cb = static_cast<unsigned char>(i < b.size() ? b[i] : 0);
    diff |= static_cast<unsigned>(ca ^ cb);
  }
  return diff == 0;
}

ControlAuthenticator::ControlAuthenticator(ControlCredentials credentials, Logger& logger)
    : credentials_(std::move(credentials)), logger_(logger) {}

UA_StatusCode ControlAuthenticator::authenticate(std::string_view user, std::string_view password,
                                                 void** session_context) const {
  // Evaluate both comparisons so that the timing does not reveal which one failed.
  const bool user_ok = constant_time_equal(user, credentials_.user);
  const bool password_ok = constant_time_equal(password, credentials_.password);
  if (!(user_ok && password_ok)) {
    logger_.warn("authentication failed: invalid user name or password");
    return UA_STATUSCODE_BADUSERACCESSDENIED;
  }
  *session_context = &g_control_session_marker;
  logger_.info("control account authenticated");
  return UA_STATUSCODE_GOOD;
}

UA_StatusCode ControlAuthenticator::install(UA_ServerConfig* config) {
  // X.509 user identity tokens are not offered: the default plugin advertises them whenever the
  // session PKI can verify certificates. (verifyApplicationURI stays: CreateSession needs it.)
  config->sessionPKI.verifyCertificate = nullptr;

  // The plugin offers a username policy only when at least one login is configured. The array
  // is not used for matching (the callback does that); it merely announces the account.
  UA_UsernamePasswordLogin announced;
  announced.username = ua_view(credentials_.user);
  announced.password = ua_view("-");
  const UA_StatusCode status = UA_AccessControl_defaultWithLoginCallback(
      config, /*allowAnonymous=*/true, /*userTokenPolicyUri=*/nullptr, 1, &announced,
      login_trampoline, this);
  if (status != UA_STATUSCODE_GOOD) return status;

  UA_AccessControl& ac = config->accessControl;
  ac.getUserExecutable = method_executable_by;
  ac.getUserExecutableOnObject = allow_call;
  ac.allowAddNode = deny_add_node;
  ac.allowAddReference = deny_add_reference;
  ac.allowDeleteNode = deny_delete_node;
  ac.allowDeleteReference = deny_delete_reference;
  return UA_STATUSCODE_GOOD;
}

}  // namespace seatrace::sim::opcua
