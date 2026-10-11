#include "core/rng.hpp"

#include <gtest/gtest.h>

#include <cmath>
#include <set>

namespace seatrace::sim {
namespace {

TEST(Rng, SameSeedGivesSameSequence) {
  Rng a(7);
  Rng b(7);
  for (int i = 0; i < 1000; ++i) ASSERT_EQ(a.gaussian(), b.gaussian());
}

TEST(Rng, DifferentSeedsGiveDifferentSequences) {
  Rng a(7);
  Rng b(8);
  int equal = 0;
  for (int i = 0; i < 100; ++i) equal += a.gaussian() == b.gaussian() ? 1 : 0;
  EXPECT_EQ(equal, 0);
}

TEST(Rng, UniformIsInUnitIntervalAndMatchesTheMt19937_64Specification) {
  // std::mt19937_64 with the default seed 5489 produces 14514284786278117030 as its first
  // output (fixed by the C++ standard); our uniform() keeps the top 53 bits of it.
  Rng rng(5489);
  const double expected = static_cast<double>(14514284786278117030ULL >> 11) / 9007199254740992.0;
  EXPECT_EQ(rng.uniform(), expected);
  for (int i = 0; i < 10000; ++i) {
    const double u = rng.uniform();
    ASSERT_GE(u, 0.0);
    ASSERT_LT(u, 1.0);
  }
}

TEST(Rng, GaussianHasStandardNormalMoments) {
  Rng rng(12345);
  constexpr int kSamples = 200000;
  double sum = 0.0;
  double sum_squares = 0.0;
  double within_one_sigma = 0.0;
  for (int i = 0; i < kSamples; ++i) {
    const double z = rng.gaussian();
    sum += z;
    sum_squares += z * z;
    within_one_sigma += std::abs(z) < 1.0 ? 1.0 : 0.0;
    ASSERT_TRUE(std::isfinite(z));
  }
  const double mean = sum / kSamples;
  const double variance = sum_squares / kSamples - mean * mean;
  EXPECT_NEAR(mean, 0.0, 0.01);
  EXPECT_NEAR(variance, 1.0, 0.02);
  EXPECT_NEAR(within_one_sigma / kSamples, 0.6827, 0.01);
}

TEST(Rng, GaussianWithMeanAndSigma) {
  Rng rng(99);
  double sum = 0.0;
  for (int i = 0; i < 50000; ++i) sum += rng.gaussian(10.0, 2.0);
  EXPECT_NEAR(sum / 50000, 10.0, 0.05);
}

TEST(SeedDerivation, IsStableAndLabelSensitive) {
  EXPECT_EQ(derive_seed(42, "VES-001.ME1.Temperature"), derive_seed(42, "VES-001.ME1.Temperature"));
  std::set<std::uint64_t> seeds;
  for (const char* label : {"VES-001.ME1.Temperature", "VES-001.ME1.Rpm", "VES-002.ME1.Temperature",
                            "VES-001.ME1#process", ""}) {
    seeds.insert(derive_seed(42, label));
  }
  EXPECT_EQ(seeds.size(), 5U);
  EXPECT_NE(derive_seed(42, "x"), derive_seed(43, "x"));
}

TEST(SeedDerivation, PinnedValuesDoNotDrift) {
  // Reproducibility across builds and platforms depends on these exact integer functions.
  EXPECT_EQ(splitmix64(0), 0xE220A8397B1DCDAFULL);
  EXPECT_EQ(fnv1a64(""), 0xCBF29CE484222325ULL);
  EXPECT_EQ(fnv1a64("a"), 0xAF63DC4C8601EC8CULL);
}

}  // namespace
}  // namespace seatrace::sim
