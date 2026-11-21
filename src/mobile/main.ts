import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

/* PWA 入口：只负责挂载，界面在 App.vue（SFC 预编译，CSP 无需 unsafe-eval）。 */

const app = createApp(App)

app.mount('#app')
