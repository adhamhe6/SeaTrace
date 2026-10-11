#pragma once

#include <chrono>
#include <optional>

#include "core/measurement.hpp"
#include "core/rng.hpp"
#include "core/scenario.hpp"
#include "core/sim_time.hpp"

namespace seatrace::sim {

// How long a recovered sensor reports Uncertain quality.
inline constexpr std::chrono::seconds kRecoveryUncertainDuration{10};

struct SensorFault {
  SensorFaultKind kind = SensorFaultKind::kNone;
  double absurd_value = 0.0;  // value published by an out-of-range sensor
};

// Turns a true process value into the reading a sensor publishes: Gaussian noise, clamping to the
// sensor's physical range and the fault modes of the scenario catalogue.
//   kStuck       the value freezes at the last good reading (status stays Good)
//   kOutOfRange  a physically impossible value is published with Good status
//   kFailed      Bad status; the value is the last good reading and must be ignored
// When a fault ends the sensor publishes Uncertain for kRecoveryUncertainDuration.
// The noise stream is consumed on every call so that it does not depend on the fault state.
class Sensor {
 public:
  Sensor(MeasurementSpec spec, Rng rng);

  const Reading& sample(double true_value, SensorFault fault, SimTime now);

  const Reading& reading() const { return reading_; }
  const MeasurementSpec& spec() const { return spec_; }
  bool faulted() const { return kind_ != SensorFaultKind::kNone; }
  bool recovering(SimTime now) const { return recovering_until_ && now < *recovering_until_; }

 private:
  MeasurementSpec spec_;
  Rng rng_;
  Reading reading_;
  SensorFaultKind kind_ = SensorFaultKind::kNone;
  std::optional<double> last_good_;
  std::optional<double> frozen_;
  std::optional<SimTime> recovering_until_;
};

}  // namespace seatrace::sim
