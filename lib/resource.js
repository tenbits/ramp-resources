var _ = require("lodash");
var mime = require("mime");
var httpProxy = require("./http-proxy");
var url = require("url");
var invalid = require("./invalid-error");
var when = require("when");
var iife = require("./processors/iife");
var crypto = require("crypto");

function isText(mimeType) {
    return (/text|html|javascript/).test(mimeType);
}

function contentType(mimeType, encoding) {
    return mimeType + (isText(mimeType) ? "; charset=" + encoding : "");
}

function parseUrl(backend) {
    return url.parse(backend.replace(/^(?:http:\/\/)?/, "http://"));

}

exports.isQualified = function (path) {
    return (/^[a-z]+:\/\//i).test(path);
};

/**
 * Create a new resource. Note that some properties can only be
 * set when creating resources through a resource set. See resourceSet
 * docs for information.
 *
 * Accepted properties:
 * - etag      Custom etag for resource (used for caching)
 * - headers   Object with headers
 * - encoding  Encoding of content, default utf-8
 * - content   Content as a string or buffer
 * - backend   A URL to a backend proxy that handles requests to
 *             {backend}/path/
 *
 * Only one of content and backend can be used in any given resource.
 */
exports.create = function (path, rs) {
    if (!exports.isQualified(path)) {
        var err = exports.validate(rs);
        if (err) { throw err; }
        path = exports.normalizePath(path);
    }
    rs = rs || {};
    var content = rs.content;
    var processors = [];
    var resourceHeaders = rs.headers;
    var resource;
    var alternatives = [];

    /**
     * Returns true if resource path has a file extension
     */
    function hasExtension() {
        return path.split("/").pop().indexOf(".") >= 0;
    }

    /**
     * Returns the mime type. Mime type is deferred from the path if
     * the path has a file extension. Otherwise, it defaults to text/html
     */
    function mimeType() {
        return rs.mimeType ||
            (hasExtension() ? mime.lookup(path) : "text/html");
    }

    function defaultEncoding() {
        return isText(mimeType()) ? "utf-8" : "base64";
    }

    function serializeAlternatives() {
        var alts = [], d = when.defer();
        when.all(alternatives.map(function (alt, i) {
            var promise = alt.serialize();
            promise.then(function (serializedAlt) { alts[i] = serializedAlt; });
            return promise;
        })).then(function () { d.resolve(alts); }, d.reject);
        return d.promise;
    }

    function serialized(content) {
        var data = {
            content: content,
            path: path,
            encoding: resource.encoding,
            cacheable: resource.cacheable
        };
        if (rs.mimeType) { data.mimeType = rs.mimeType; }
        if (resource.etag) { data.etag = resource.etag; }
        if (resourceHeaders) { data.headers = resourceHeaders; }
        if (resource.exports) {
            data.enclose = true;
            data.exports = resource.exports;
        }
        try {
            if (content && alternatives.length > 0) {
                var d = when.defer();
                serializeAlternatives().then(function (alts) {
                    data.alternatives = alts;
                    d.resolve(data);
                }, d.reject);
                return d.promise;
            }
        } catch (e) {
            return when.reject(e);
        }
        return when(data);
    }

    function backendProxy(url) {
        var p = parseUrl(url);
        var proxy = httpProxy.create(p.hostname, p.port || 80, p.pathname);
        proxy.setProxyPath(path);
        return proxy;
    }

    /**
     * Runs all processors on resource content.
     */
    function processContent(content) {
        return processors.reduce(function (c, processor) {
            var result = processor(resource, c);
            return typeof result === "string" ? result : c;
        }, content);
    }

    function processedStringContent(content) {
        return processContent(content.toString(resource.encoding));
    }

    function processedFunctionContent(fn) {
        var d = when.defer();
        when(fn.call(resource)).then(function (content) {
            try {
                d.resolve(processedStringContent(content));
            } catch (e) {
                d.reject(e);
            }
        }, d.reject);
        return d.promise;
    }

    var originalEtag = rs.etag;

    function alternativeCacheKeys() {
        return alternatives.sort(function (a, b) {
            var atype = a.mimeType();
            var btype = b.mimeType();
            return atype < btype ? 1 : (btype < atype ? -1 : 0);
        }).map(function (alt) {
            return alt.etag || alt.mimeType();
        });
    }

    function recalculateEtag() {
        var shasum = crypto.createHash("sha1");
        shasum.update(originalEtag + processors.map(function (p) {
            return p.toString() || "";
        }).join("") + alternativeCacheKeys().join(""));
        resource.etag = shasum.digest("hex");
    }

    resource = {
        path: path,
        combine: rs.combine,
        etag: rs.etag,
        backend: rs.backend,
        cacheable: rs.hasOwnProperty("cacheable") ? rs.cacheable : true,
        encoding: rs.encoding || defaultEncoding(),

        /**
         * Get headers to serve resource with. Always returns an object,
         * even if empty. Content resources always have a default
         * Content-Type header, that can be overridden through the
         * headers object when creating the resource.
         */
        headers: function () {
            var headers = {};
            if (content) {
                var type = contentType(mimeType(), this.encoding);
                headers["Content-Type"] = type;
            }
            if (this.etag) {
                headers.ETag = this.etag;
            }
            return _.extend(headers, resourceHeaders);
        },

        /**
         * Returns the value of the single named header.
         */
        header: function (header) {
            return this.headers()[header];
        },

        mimeType: mimeType,

        /**
         * Get resource contents. Returns a prmise if resource has 'content',
         * or an http proxy object if the resource has a backend.
         * Buffer contents will be converted to a string using the provided
         * encoding, utf-8 by default.
         */
        content: function () {
            if (exports.isQualified(path)) {
                return when(path);
            }
            if (typeof content === "function") {
                return processedFunctionContent(content);
            }
            if (!this.backend) {
                try {
                    return when(processedStringContent(content));
                } catch (e) {
                    return when.reject(e);
                }
            }
            if (!this.proxy) { this.proxy = backendProxy(this.backend); }
            return this.proxy;
        },

        setContent: function (c) {
            content = c;
        },

        /**
         * Add resource processor
         */
        addProcessor: function (processor) {
            processors.push(processor);
            recalculateEtag();
            return this;
        },

        hasProcessors: function () {
            return processors.length > 0;
        },

        process: function () {
            if (this.hasProcessors()) {
                return this.content();
            }
            return when(null);
        },

        /**
         * Returns true if resource exists at path. For most resources,
         * this is a check of normalizedPath(path) === path, but for e.g.
         * proxy resources, this may be true for a whole range of paths.
         */
        respondsTo: function (reqPath) {
            var pattern = new RegExp("^" + path + (content ? "$" : ""));
            return pattern.test(exports.normalizePath(reqPath));
        },

        /**
         * Serialize a resource. You can exclude the content by calling
         * serialize with serialize({ includeContent: false }), can be
         * useful when both sides of the serialization uses a resource
         * cache.
         */
        serialize: function (options) {
            if (this.backend) {
                return when({ path: this.path, backend: this.backend });
            }
            var d = when.defer();
            function resolve(content) {
                serialized(content).then(d.resolve, d.reject);
            }
            if (!options || options.includeContent) {
                try {
                    this.content().then(resolve, d.reject);
                } catch (e) {
                    d.reject(e);
                }
            } else {
                resolve("");
            }
            return d.promise;
        },

        getContentFor: function (mime) {
            if (mime === mimeType()) { return this; }
            return alternatives.filter(function (r) {
                return r.getContentFor(mime);
            })[0];
        },

        addAlternative: function (options) {
            var i, l, added, alternative = exports.create(path, options);
            for (i = 0, l = alternatives.length; i < l; ++i) {
                if (alternatives[i].mimeType() === options.mimeType) {
                    alternatives[i] = alternative;
                    added = true;
                }
            }
            if (!added) { alternatives.push(alternative); }
            recalculateEtag();
        }
    };

    if (rs.enclose) {
        resource.exports = rs.exports || [];
        resource.addProcessor(iife(resource.exports));
    }

    if (rs.alternatives) {
        rs.alternatives.forEach(function (alt) {
            resource.addAlternative(alt);
        });
    }

    return resource;
};

exports.normalizePath = function (path) {
    if (exports.isQualified(path)) { return path; }
    return path.replace("\\", "/").replace(/\/?$/, "").replace(/^\/?/, "/");
};

exports.isResource = function (resource) {
    return typeof resource.addProcessor === "function";
};

/**
 * Validates the combination of properties for a resource. Returns
 * an error object with the first error if any. Otherwise, returns
 * falsy.
 */
exports.validate = function (resource) {
    resource = resource || {};
    if (!resource.content && !resource.backend && !resource.etag) {
        return invalid("No content: Resource must have " +
                       "content, etag or backend");
    }
    if (resource.content && resource.backend) {
        return invalid("Resource cannot have both content and backend");
    }
    if (!resource.backend) { return; }
    if (resource.encoding) {
        return invalid("Proxy resource cannot have hard-coded encoding");
    }
    var parsed = parseUrl(resource.backend);
    if (!parsed.hostname) {
        return invalid("Invalid proxy backend '" + resource.backend + "'");
    }
};
