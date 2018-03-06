const sha1 = require('./sha1.js');

import PermissionsManager from './permissions.js';
import ApiMerger          from './merger.js';
import { mergePost }      from './init.js';

Vue.mixin({

    created() {
        this.$intervals = [];
    },

    destroyed: function () {
        this.$api.unbindVue(this);

        if (this.listenerId) {
            this.$api.unbindListener(this.listenerId);
        }

        if(this.$intervals) {
            this.$intervals.forEach(function(id) {
                clearInterval(id);
            });
        }
    },

    methods: {
        $logCatch: function () {
            var arg = Array.prototype.slice.call(arguments);

            if (this.name)
                arg.unshift(this._name);

            console.error.apply(console, arg);
        },

        $bindApi: function (api, data) {
            this.$api.bindVue(this, api, data);
        },

        $replaceApi: function (api, data) {
            const uid = this._uid;
            const binded = this.$api.bindedVueElements.find(function(obj) {
                return (obj.objectId == uid);
            });

            if(!binded || binded.api !== api || JSON.stringify(data) !== JSON.stringify(binded.data)) {
                this.$api.replaceVueApi(this, api, data);
            }
        },
        
        $onApi(api, data, cb) {
            const $id = this.$api.on(api, data, cb);
            
            this.$api.bindedVueElements.push({
                listenerId: $id,
                objectId: this._uid,
                object: this,
                api:    api,
                data:   data
            });
        },

        $refreshApi(api, post) {
            var postIn = post;

            if(!api) 
                postIn || this.api_data;

            this.$api.refresh(api || this.api, postIn || {});
        },
        
        $setInterval(fn, time) {
            const id = setInterval(fn, time);
            this.$intervals.push(id);
            return id;
        }
    },

    watch: {
        api(val, oldVal) {
            if(val === oldVal)
                return;

            this.$nextTick(() => {
                this.$replaceApi(this.api, this.api_data);
            });
        },

        api_data(val, oldVal) {
            if(val === oldVal)
                return;

            this.$nextTick(() => {
                this.$replaceApi(this.api, this.api_data);
            });
        }
    }
});

class ApiManager
{
    constructor() {
        this.isDev              = (process.env.NODE_ENV === 'development');
        this.idIncrementer      = 0;
        this.fetchingApis       = [];
        this.onOpenCallbacks    = [];
        this.onApiCallbacks     = [];
        this.bindedVueElements  = [];
        this.socketIsOpen       = false;
        this.token              = this.getCookie('token');
        this.userConnection     = null;
        this.socketHooks        = [];
        this.permissionsManager = new PermissionsManager(this);
    }

    generateToken() {
        const hash = sha1(Date.now() + '-' + Math.random() + '-' + Math.random() + 'CoreApi').substr(4, 28);
        this.token = hash.substr(Math.round(Math.random() * 10), 16);
        this.setCookies({
            "token": this.token
        }, Date.now() + (24 * 60 * 60 * 1000));
        return this.token;
    }

    install(app, options)
    {
        app.prototype.$api = this;

        app.prototype.$submitForm = function(form)
        {
            if(typeof(form) === 'string')
                form = this.$refs[form];

            this.$api.formPoster.handleFormSubmit(form);
        };
    }

    //---------------------------------------------------------

    handleApiError(api, error, salt) {
        if (error.httpCode === 401) {
            this.deleteAllCache();

            if(this.permissionsManager)
                this.permissionsManager.setPermissions([]);

            if (location.pathname !== '/' && location.pathname !== '/members') //ToDo if not offline page redirect to members page
            {
                location.href = '/members';
            }
        }

        for (var i = this.fetchingApis.length - 1; i >= 0; i--) {
            if (this.fetchingApis[i].salt === salt) {
                this.fetchingApis.splice(i, 1);
            }
        }
        
        var found = false;
        for (var key in this.onApiCallbacks) {
            try {
                const post = this.mergePost(JSON.parse(JSON.stringify(this.onApiCallbacks[key].post)));

                if (this.getSalt(this.onApiCallbacks[key].api, post) === salt && this.onApiCallbacks[key].errorCallback)
                {
                    found = true;
                    this.onApiCallbacks[key].errorCallback.call(this, error, api, this.onApiCallbacks[key].id);
                }
            } catch (e)
            {
                console.error(e);
            }
        }
        
        if(!found && this.isDev)
            console.error('Api Error', api, error);
    }

    getSalt(api, data) {
        var dataJ = JSON.stringify(data);
        if (dataJ.length == 0) return api;

        var char, hash = 0;

        for (var i = 0; i < dataJ.length; i++) {
            char = dataJ.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }

        return api + '_' + Math.abs(hash);
    }

    isFetching(salt) {
        var timeout = Date.now() - (15 * 1000); //15 Secondes

        for (var i = this.fetchingApis.length - 1; i >= 0; i--) {
            if (this.fetchingApis[i].time <= timeout) {
                this.fetchingApis.splice(i, 1);
            } else if (this.fetchingApis[i].salt === salt) {
                return true;
            }
        }

        return false;
    }

    setFetching(salt) {
        this.fetchingApis.push({
            salt: salt,
            time: Date.now()
        });
    }

    //---------------------------------------------------------

    logout()
    {
        this.userConnection = null;
        //this.deleteLocalCache('connection');
        //this.deleteLocalCache('mode');
        this.fetchingApis = [];

        this.permissionsManager.setPermissions([]);
        this.emitApi('logout', {});

        //Delete all local caches of this token
        if (!this.isClient)
            return null;

        try {
            if (typeof (localStorage) == "object") {
                for (var i = localStorage.length - 1; i >= 0; i--) {
                    var key = localStorage.key(i);
                    var index = key.indexOf('_');

                    if (key.substr(0, index) === this.token) {
                        localStorage.removeItem(key);
                    }
                }
            }
        } catch (e) {
            console.error(e);
        }

        this.sendSocketMessage({
            event: 'logout'
        });
    }

    setCredentials(credentials)
    {
        return this.permissionsManager.setPermissions(credentials);
    }

    isConnected()
    {
        return this.permissionsManager.connected();
    }

    //---------------------------------------------------------

    mergePost(data)
    {
        return mergePost(data || {});
    }

    on(api, data, cb, salt)
    {
        if (typeof (data) === 'function' || data === undefined || data === null) {
            cb = data;
            data = {};
        }

        if (!salt)
        {
            data = mergePost(data);
            salt = this.getSalt(api, data);
        }

        this.idIncrementer++;
        var id = this.idIncrementer;

        this.onApiCallbacks.push({
            id: id,
            api: api,
            post: data,
            //salt: salt,
            callback: cb
        });

        if (this.idIncrementer > 1000000)
            this.idIncrementer = 0;

        const cache = this.getLocalCache(salt);

        if (cache !== null) {
            try {
                cb.call(this, cache, api, id);
            } catch (e) {
                console.error(e);
            }
        }

        return id;
    }

    require(api, data, cb) {
        if (typeof (data) === 'function' || data === undefined || data === null) {
            cb = data;
            data = {};
        }

        data = mergePost(data);

        var id = 0;
        const salt = this.getSalt(api, data);

        if (cb)
            id = this.on(api, data, cb, salt);

        if (this.isFetching(salt)) //ToDo call function to check if it is a fake (live) api
            return;

        this.setFetching(salt);

        return {
            id: id,
            salt: salt,
            data: data
        };
    }

    refresh(api, data) {
        if (typeof (data) === 'function' || data === undefined || data === null) {
            data = {};
        }

        data = mergePost(data);

        return {
            data: data,
            salt: this.getSalt(api, data)
        };
    }

    post(api, data) {

        this.idIncrementer++;
        const _this = this;
        const id    = this.idIncrementer;
        data        = mergePost(data);

        return {
            salt: this.getSalt(api, data),
            data: data,
            id:   id
        };
    }

    //----------------

    unbindListener(id) {
        for (var i = this.onApiCallbacks.length - 1; i >= 0; i--) {
            if (this.onApiCallbacks[i].id === id) {
                this.onApiCallbacks.splice(i, 1);
            }
        }
    }

    unbindVue(object) {
        var elements = this.bindedVueElements;
        this.bindedVueElements = [];

        for (var key in elements) {
            if (elements[key].objectId == object._uid) {
                this.unbindListener(elements[key].listenerId);
            } else {
                this.bindedVueElements.push(elements[key]);
            }
        }
    }

    bindVue(object, api, data) {
        if (!data)
            data = {};

        if (api === '')
            return;

        const isClient = this.isClient;
        function bindData(nData)
        {
            if(!object._isMounted && isClient && !object.$root._isMounted)
            {
                return object.$nextTick(function()
                {
                    bindData(data);
                });
            }

            ApiMerger(object, nData);
        }

        const listenerId = this.require(api, data, bindData);

        this.bindedVueElements.push({
            listenerId: listenerId,
            objectId: object._uid,
            object: object,
            api:    api,
            data:   data
        });

        return object;
    }

    replaceVueApi(object, api, data) {
        this.unbindVue(object);
        this.bindVue(object, api, data);
    }

    linkedApi(object, data) {
        if (!data)
            data = {};
        var api = $(object.$el).attr('linkedApi');
        this.require(api, data, function (nData) {
            object.items = nData;
        }, false);
    }
}

export default ApiManager;