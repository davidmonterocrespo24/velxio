import { createRoot } from 'react-dom/client'
import './index.css'
import './components/components-wokwi/IC74HC595'
import './components/components-wokwi/LogicGateElements'
import './components/components-wokwi/TransistorElements'
import './components/components-wokwi/OpAmpElements'
import './components/components-wokwi/PowerElements'
import './components/components-wokwi/DiodeElements'
import './components/components-wokwi/RelayElements'
import './components/components-wokwi/LogicICElements'
import './components/components-wokwi/FlipFlopElements'
import './components/components-wokwi/RaspberryPi3Element'
import './components/components-wokwi/Bmp280Element'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <App />,
)
