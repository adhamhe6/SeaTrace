#include "core/sensor.hpp"

#include <algorithm>

namespace seatrace::sim {

Sensor::Sensor(MeasurementSpec spec, Rng rng) : spec_(std::move(spec)), rng_(rng) {}

const Reading& Sensor::sample(double true_value, SensorFault fault, SimTime now) {
  const double noise = rng_.gaussian() * spec_.noise_sigma;
  const double measured = std::clamp(true_value + noise, spec_.plausible_min, spec_.plausible_max);

  if (fault.kind == SensorFaultKind::kNone && kind_ != SensorFaultKind::kNone) {
    recovering_until_ = now + kRecoveryUncertainDuration;
  } else if (fault.kind != SensorFaultKind::kNone) {
    recovering_until_.reset();
  }
  if (fault.kind != SensorFaultKind::kStuck) frozen_.reset();
  kind_ = fault.kind;

  switch (fault.kind) {
    case SensorFaultKind::kNone:
      last_good_ = measured;
      reading_ = {measured, recovering(now) ? Quality::kUncertain : Quality::kGood};
      break;
    case SensorFaultKind::kStuck:
      if (!frozen_) frozen_ = last_good_.value_or(measured);
      reading_ = {*frozen_, Quality::kGood};
      break;
    case SensorFaultKind::kOutOfRange:
      reading_ = {fault.absurd_value, Quality::kGood};
      break;
    case SensorFaultKind::kFailed:
      reading_ = {last_good_.value_or(0.0), Quality::kBadSensorFailure};
      break;
  }
  return reading_;
}

}  // namespace seatrace::sim
