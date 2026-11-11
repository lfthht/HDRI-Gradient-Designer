// Test driver: evaluates the reference Prague sky model on fixed inputs and prints the values,
// so the Python port (prague_sky.py) can be compared number by number.
#include <cstdio>
#include <tuple>
#include <array>
#include <limits>
#include "PragueSkyModel.h"

int main(int argc, char** argv) {
    PragueSkyModel m;
    m.initialize(argv[1]);
    const double cfg[][3] = { {30.0, 59.4, 0.5}, {-2.0, 20.0, 0.1}, {3.0, 131.8, 0.9}, {0.4, 40.0, 0.2}, {75.0, 90.0, 0.33} };
    const double dirs[][3] = { {0, 0, 1}, {1, 0, 0.0001}, {-1, 0, 0.05}, {0, 1, 0.2}, {0.3, -0.5, 0.4}, {0.99, 0.02, 0.06}, {-0.2, 0.7, 0.01} };
    const double PI = 3.141592653589793;
    for (auto& c : cfg) {
        const double el = c[0] * PI / 180.0;
        for (auto& d : dirs) {
            PragueSkyModel::Parameters p = m.computeParameters(PragueSkyModel::Vector3(0, 0, 0),
                PragueSkyModel::Vector3(d[0], d[1], d[2]), el, 0.0, c[1], c[2]);
            printf("SKY %g %g %g |", c[0], c[1], c[2]);
            for (int ch = 0; ch < 11; ++ch) printf(" %.9g", m.skyRadiance(p, 340.0 + 40.0 * ch));
            printf("\n");
        }
        PragueSkyModel::Parameters ps = m.computeParameters(PragueSkyModel::Vector3(0, 0, 0),
            PragueSkyModel::Vector3(cos(el), 0, sin(el)), el, 0.0, c[1], c[2]);
        printf("SUN %g %g %g |", c[0], c[1], c[2]);
        for (double wl : {400.0, 450.0, 500.0, 550.0, 600.0, 650.0, 700.0}) printf(" %.9g", m.sunRadiance(ps, wl));
        printf("\n");
    }
    return 0;
}
