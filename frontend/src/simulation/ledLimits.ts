/**
 * Above this an LED's solved current is no physical figure: nothing in the
 * circuit limits it. An ideal source (the pre-run check's GPIO, a bench
 * supply) across a bare LED solves at trillions of amperes. Both the pre-run
 * check and a running LED word that case without the figure
 * (velxio/velxio-prod#21).
 */
export const LED_UNLIMITED_AMPS = 1;
