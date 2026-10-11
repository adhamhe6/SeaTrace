#pragma once

#include <cstdint>
#include <random>
#include <string_view>

namespace seatrace::sim {

// splitmix64 finaliser: a cheap, well-mixed bijection on 64-bit integers.
std::uint64_t splitmix64(std::uint64_t x);

// FNV-1a over the bytes of `text` (portable, specified bit for bit).
std::uint64_t fnv1a64(std::string_view text);

// Derives an independent sub-stream seed from the global seed and a stable label such as
// "VES-001.ME1.Temperature". The same (seed, label) pair always yields the same stream.
std::uint64_t derive_seed(std::uint64_t global_seed, std::string_view label);

// Deterministic random source. std::mt19937_64 output and seeding are fully specified by the C++
// standard, and the Gaussian transform below is our own Box-Muller implementation (instead of
// std::normal_distribution, whose algorithm is implementation-defined), so the sequence is the
// same with every standard library. The only remaining platform dependence is libm's last-ulp
// behaviour for log/sqrt/sin/cos.
class Rng {
 public:
  explicit Rng(std::uint64_t seed);

  // Uniform in [0, 1) with 53 bits of resolution.
  double uniform();
  // Standard normal N(0, 1).
  double gaussian();
  double gaussian(double mean, double sigma) { return mean + sigma * gaussian(); }

 private:
  std::mt19937_64 engine_;
  bool has_spare_ = false;
  double spare_ = 0.0;
};

}  // namespace seatrace::sim
