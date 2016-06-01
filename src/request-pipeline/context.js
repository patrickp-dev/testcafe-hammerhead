import XHR_HEADERS from './xhr/headers';
import Charset from '../processing/encoding/charset';
import * as urlUtils from '../utils/url';
import * as contentTypeUtils from '../utils/content-type';

const REDIRECT_STATUS_CODES = [301, 302, 303, 307];

// TODO: Rewrite parseProxyUrl instead.
function flattenParsedProxyUrl (parsed) {
    if (parsed) {
        var parsedResourceType = urlUtils.parseResourceType(parsed.resourceType);

        return {
            dest: {
                url:           parsed.destUrl,
                protocol:      parsed.destResourceInfo.protocol,
                host:          parsed.destResourceInfo.host,
                hostname:      parsed.destResourceInfo.hostname,
                port:          parsed.destResourceInfo.port,
                partAfterHost: parsed.destResourceInfo.partAfterHost,
                isIframe:      parsedResourceType.isIframe,
                isForm:        parsedResourceType.isForm,
                isScript:      parsedResourceType.isScript,
                charset:       parsed.charset
            },

            sessionId: parsed.sessionId
        };
    }

    return null;
}


export default class RequestPipelineContext {
    constructor (req, res, serverInfo) {
        this.serverInfo = serverInfo;
        this.session    = null;

        this.req     = req;
        this.reqBody = null;
        this.res     = res;

        this.dest          = null;
        this.destRes       = null;
        this.destResBody   = null;
        this.hasDestReqErr = false;

        this.isXhr         = false;
        this.isFetch       = false;
        this.isPage        = false;
        this.isIframe      = false;
        this.isSpecialPage = false;
        this.contentInfo   = null;

        var acceptHeader = req.headers['accept'];

        this.isXhr   = !!req.headers[XHR_HEADERS.requestMarker];
        this.isFetch = !!req.headers[XHR_HEADERS.fetchRequestCredentials];
        this.isPage  = !this.isXhr && !this.isFetch && acceptHeader && contentTypeUtils.isPage(acceptHeader);
    }

    _getDestFromReferer (parsedReferer) {
        // NOTE: Browsers may send the default port in the 'referer' header. But since we compose the destination
        // URL from it, we need to skip the port number if it's the protocol's default port. Some servers have
        // host conditions that do not include a port number.
        var rDest         = parsedReferer.dest;
        var isDefaultPort = rDest.protocol === 'https:' && rDest.port === '443' ||
                            rDest.protocol === 'http:' && rDest.port === '80';

        var dest = {
            protocol:      rDest.protocol,
            host:          isDefaultPort ? rDest.host.split(':')[0] : rDest.host,
            hostname:      rDest.hostname,
            port:          isDefaultPort ? '' : rDest.port,
            partAfterHost: this.req.url
        };

        dest.url = urlUtils.formatUrl(dest);

        return {
            dest:      dest,
            sessionId: parsedReferer.sessionId
        };
    }

    _isFileDownload () {
        var contentDisposition = this.destRes.headers['content-disposition'];

        return contentDisposition &&
               contentDisposition.indexOf('attachment') > -1 &&
               contentDisposition.indexOf('filename') > -1;
    }

    _getInjectable (injectable) {
        return injectable.map(url => this.serverInfo.domain + url);
    }

    _initRequestNatureInfo () {
        var acceptHeader = this.req.headers['accept'];

        this.isXhr    = !!this.req.headers[XHR_HEADERS.requestMarker];
        this.isPage   = !this.isXhr && acceptHeader && contentTypeUtils.isPage(acceptHeader);
        this.isIframe = this.dest.isIframe;
    }

    // API
    dispatch (openSessions) {
        var parsedReqUrl  = urlUtils.parseProxyUrl(this.req.url);
        var referer       = this.req.headers['referer'];
        var parsedReferer = referer && urlUtils.parseProxyUrl(referer);

        // TODO: Remove it after parseProxyURL is rewritten.
        parsedReqUrl  = flattenParsedProxyUrl(parsedReqUrl);
        parsedReferer = flattenParsedProxyUrl(parsedReferer);

        // NOTE: Try to extract the destination from the 'referer' header.
        if (!parsedReqUrl && parsedReferer)
            parsedReqUrl = this._getDestFromReferer(parsedReferer);

        if (parsedReqUrl) {
            this.session = openSessions[parsedReqUrl.sessionId];

            if (!this.session)
                return false;

            this.dest        = parsedReqUrl.dest;

            // Browsers add a leading slash to the pathname part of url (GH-608)
            // For example: url http://www.trovigo.com?gd=GID12082014 will be converted
            // to http://www.trovigo.com/?gd=GID12082014
            this.dest.partAfterHost = this.dest.partAfterHost[0] === '/' ? this.dest.partAfterHost : '/' + this.dest.partAfterHost;

            this.dest.domain = urlUtils.getDomain(this.dest);

            if (parsedReferer) {
                this.dest.referer   = parsedReferer.dest.url;
                this.dest.reqOrigin = urlUtils.getDomain(parsedReferer.dest);
            }
            else if (this.req.headers[XHR_HEADERS.origin])
                this.dest.reqOrigin = this.req.headers[XHR_HEADERS.origin];

            this._initRequestNatureInfo();

            return true;
        }

        return false;
    }

    buildContentInfo () {
        var contentType = this.destRes.headers['content-type'] || '';
        var accept      = this.req.headers['accept'] || '';
        var encoding    = this.destRes.headers['content-encoding'];

        var isCSS                   = contentTypeUtils.isCSSResource(contentType, accept);
        var isManifest              = contentTypeUtils.isManifest(contentType);
        var isScript                = this.dest.isScript || contentTypeUtils.isScriptResource(contentType, accept);
        var isForm                  = this.dest.isForm;
        var isFormWithEmptyResponse = isForm && this.destRes.statusCode === 204;

        var isRedirect              = this.destRes.headers['location'] &&
                                      REDIRECT_STATUS_CODES.indexOf(this.destRes.statusCode) > -1;
        var requireAssetsProcessing = (isCSS || isScript || isManifest) && this.destRes.statusCode !== 204;
        var requireProcessing       = !this.isXhr && !this.isFetch && !isFormWithEmptyResponse && !isRedirect &&
                                      (this.isPage || this.isIframe || requireAssetsProcessing);

        var isFileDownload = this._isFileDownload();

        var isIframeWithImageSrc = this.isIframe && !this.isPage && /^\s*image\//.test(contentType);

        var charset             = null;
        var contentTypeUrlToken = urlUtils.stringifyResourceType(this.isIframe, isForm, isScript);

        // NOTE: We need charset information if we are going to process the resource.
        if (requireProcessing) {
            charset = new Charset();

            if (!charset.fromContentType(contentType))
                charset.fromUrl(this.dest.charset);
        }

        if (isFileDownload)
            this.session.handleFileDownload();

        this.contentInfo = {
            charset,
            requireProcessing,
            isIframeWithImageSrc,
            isCSS,
            isScript,
            isManifest,
            encoding,
            contentTypeUrlToken,
            isFileDownload
        };
    }

    getInjectableScripts () {
        var taskScript = this.isIframe ? '/iframe-task.js' : '/task.js';
        var scripts    = this.session.injectable.scripts.concat(taskScript);

        return this._getInjectable(scripts);
    }

    getInjectableStyles () {
        return this._getInjectable(this.session.injectable.styles);
    }

    redirect (url) {
        this.res.statusCode = 302;
        this.res.setHeader('location', url);
        this.res.end();
    }

    closeWithError (statusCode, resBody) {
        this.res.statusCode = statusCode;

        if (resBody) {
            this.res.setHeader('content-type', 'text/html');
            this.res.end(resBody);
        }
        else
            this.res.end();
    }

    toProxyUrl (url, isCrossDomain, resourceType, charsetAttrValue) {
        var port = isCrossDomain ? this.serverInfo.crossDomainPort : this.serverInfo.port;

        return urlUtils.getProxyUrl(url, this.serverInfo.hostname, port, this.session.id, resourceType, charsetAttrValue);
    }
}
