#ifndef MORPH_DSP_H
#define MORPH_DSP_H
#include <stddef.h>
#include "MorphDenoise.h"
#ifdef __cplusplus
extern "C" {
#endif
/* LUFS metering is performed block by block; state only holds a fixed-size loudness histogram and does not store audio recording content. */
typedef struct MorphMeter MorphMeter;
MorphMeter *morph_meter_create(unsigned long rate, unsigned int channels);
int morph_meter_add_float(MorphMeter *meter, const float *samples, size_t count);
int morph_meter_add_short(MorphMeter *meter, const short *samples, size_t count);
double morph_meter_lufs(MorphMeter *meter);
double morph_meter_peak(MorphMeter *meter);
/* Automatic target -16 LUFS; manual gain also limits true peaks to -1 dBTP, with a maximum amplification of 24 dB. */
double morph_meter_gain(MorphMeter *meter, int automatic, double db);
void morph_meter_destroy(MorphMeter *meter);
#ifdef __cplusplus
}
#endif
#endif
