import SandboxBase from './base';
import nativeMethods from './native-methods';
import XHR_HEADERS from '../../request-pipeline/xhr/headers';
import { getProxyUrl, parseProxyUrl } from '../utils/url';
import { getOrigin, sameOriginCheck, get as getDestLocation } from '../utils/destination-location';
import { isFetchHeaders, isFetchRequest } from '../utils/dom';
import { SAME_ORIGIN_CHECK_FAILED_STATUS_CODE } from '../../request-pipeline/xhr/same-origin-policy';

export default class FetchSandbox extends SandboxBase {

    static _processRequestInit (init) {
        var defaultRequest     = new nativeMethods.Request('');
        var headers            = init.headers || {};
        var requestCredentials = init.credentials || defaultRequest.credentials;

        if (isFetchHeaders(headers)) {
            headers.append(XHR_HEADERS.origin, getOrigin());
            headers.append(XHR_HEADERS.fetchRequestCredentials, requestCredentials);
        }
        else {
            headers[XHR_HEADERS.origin]                  = getOrigin();
            headers[XHR_HEADERS.fetchRequestCredentials] = requestCredentials;
        }

        init.headers = headers;

        return init;
    }

    static _processArguments (args) {
        var input = args[0];
        var init  = args[1] || {};

        if (typeof input === 'string')
            args[0] = getProxyUrl(input);

        args[1] = FetchSandbox._processRequestInit(init);
    }

    static _requestIsValid (args) {
        var url         = null;
        var requestMode = null;

        if (isFetchRequest(args[0])) {
            url         = parseProxyUrl(args[0].url).destUrl;
            requestMode = args[0].mode;
        }
        else {
            url         = args[0];
            requestMode = (args[1] || {}).mode;
        }

        if (requestMode === 'same-origin')
            return sameOriginCheck(getDestLocation(), url, true);

        return true;
    }

    static _processFetchPromise (promise) {
        var originalThen = promise.then;

        promise.then = function (...args) {
            var originalThenHandler = args[0];

            args[0] = function (response) {
                Object.defineProperty(response, 'type', {
                    get: function () {
                        return FetchSandbox._getResponseType(response);
                    },
                    set: () => void 0
                });

                var responseStatus = response.status === SAME_ORIGIN_CHECK_FAILED_STATUS_CODE ? 0 : response.status;

                Object.defineProperty(response, 'status', {
                    get: function () {
                        return responseStatus;
                    },
                    set: () => void 0
                });

                arguments[0] = response;

                return originalThenHandler.apply(this, arguments);
            };

            return originalThen.apply(this, args);
        };
    }

    static _getResponseType (response) {
        var parsedResponseUrl = parseProxyUrl(response.url);
        var destUrl           = parsedResponseUrl && parsedResponseUrl.destUrl;
        var isSameOrigin      = sameOriginCheck(getDestLocation(), destUrl, true);

        if (isSameOrigin)
            return 'basic';

        return response.status === 0 ? 'opaque' : 'cors';
    }

    attach (window) {
        super.attach(window, window.document);

        var sandbox = this;

        if (window.fetch) {
            window.Request = function (...args) {
                FetchSandbox._processArguments(args);

                if (args.length === 1)
                    return new nativeMethods.Request(args[0]);

                return new nativeMethods.Request(args[0], args[1]);
            };

            window.fetch = function (...args) {
                if (!FetchSandbox._requestIsValid(args))
                    return sandbox.window.Promise.reject(new TypeError());

                FetchSandbox._processArguments(args);

                var fetchPromise = nativeMethods.fetch.apply(this, args);

                FetchSandbox._processFetchPromise(fetchPromise);

                return fetchPromise;
            };
        }
    }
}