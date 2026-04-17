import { createRoot } from 'react-dom/client'
import './index.css'
import './components/components-wokwi/IC74HC595'
import './components/components-wokwi/LogicGateElements'
import './components/components-wokwi/RaspberryPi3Element'
import './components/components-wokwi/Bmp280Element'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <App />,
)
