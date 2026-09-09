/**
 * The built-in line-owning sensor models. Importing this module registers
 * them; `requestLine` and `LineSensorHub` import it so a model is on the
 * registry wherever a sensor can be asked for or hosted, with no caller having
 * to remember. A new device is one file here and one line below.
 */
import './dht22';
import './hc-sr04';
import './ir-nec';
import './ir-tx';
