import { initApp, initGlobalApp } from '../common/init.js';
import api      from './apiManager.js';
/*import Raven    from 'raven-js';
import RavenVue from 'raven-js/plugins/vue';

if(process.env.NODE_ENV === 'production' && InitReq.getRavenKey)
{
   Raven
    .config(InitReq.getRavenKey())
    .addPlugin(RavenVue, Vue)
    .install();
}*/

const options = {
    apiManager: api
};

initGlobalApp(options);

const app = initApp(options);

if(app.$store && window.STATE)
    app.$store.replaceState(window.STATE);

app.$mount('#app');