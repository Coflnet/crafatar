// Deterministic cache regression tests; no Redis, native modules, or upstream traffic.
var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var config = {
  caching: {local: 1200, ephemeral: true},
  server: {http_timeout: 2000},
  directories: {faces: "faces", helms: "helms", skins: "skins", capes: "capes"}
};
var logger = {log: function(){}, debug: function(){}, warn: function(){}, error: function(){}};
function load(file, mocks) {
  var module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), {
    module: module, Buffer: Buffer, Date: Date, console: console,
    fetch: mocks.fetch, AbortSignal: AbortSignal,
    __dirname: path.dirname(path.join(__dirname, "..", file)),
    setInterval: function(){}, clearInterval: function(){},
    require: function(name) {
      if (name === "../config") return config;
      if (name === "./logging") return logger;
      if (Object.prototype.hasOwnProperty.call(mocks, name)) return mocks[name];
      return require(name);
    }
  }, {filename: file});
  return module.exports;
}
var uuid = "0098cb60fa8e427cb299793cbd302c9a";
var hash = "a".repeat(64);
var skin = Buffer.from("original skin");
var avatar = Buffer.from("correct avatar");
function environment(options) {
  options = options || {};
  var files = new Set(options.files || []);
  var downloads = 0, profiles = 0, timestamp;
  var details = {skin: hash, cape: hash, slim: true, time: options.stale ? 0 : Date.now()};
  var networking = {
    get_profile: function(rid, id, cb) {profiles++; cb(Object.assign(new Error("rate limited"), {code: "RATELIMIT"}));},
    save_texture: function(rid, id, out, cb) {
      downloads++;
      assert.strictEqual(id, hash);
      setImmediate(function() {
        if (options.failure) return cb(options.failure);
        files.add(out); cb(null, {statusCode: 200}, skin);
      });
    }
  };
  var helpers = load("lib/helpers.js", {
    "./networking": networking, "./renders": {},
    "./cache": {
      get_details: function(id, cb) {cb(null, details);},
      update_timestamp: function(rid, id, temp, cb) {timestamp = temp; cb(null);}
    },
    fs: {access: function(file, cb) {cb(files.has(file) ? null : Object.assign(new Error("missing"), {code: "ENOENT"}));}},
    "./skins": {
      open_skin: function(rid, file, cb) {cb(null, skin);},
      extract_face: function(buf, out, cb) {assert.deepStrictEqual(buf, skin); files.add(out); cb(null);},
      extract_helm: function(rid, face, buf, out, cb) {assert(files.has(face)); if (!options.noHelm) files.add(out); cb(null);},
      resize_img: function(file, size, cb) {assert(files.has(file)); cb(null, avatar);}
    }
  });
  return {helpers: helpers, downloads: function(){return downloads;}, profiles: function(){return profiles;}, timestamp: function(){return timestamp;}};
}
function getAvatar(env, overlay) {
  return new Promise(function(resolve, reject) {
    env.helpers.get_avatar("test", uuid, overlay, 64, function(err, status, img, returnedHash) {
      if (err) reject(err); else resolve({status: status, img: img, hash: returnedHash});
    });
  });
}
async function main() {
  var count = 0;
  async function test(name, action) {await action(); count++; console.log("ok " + count + " - " + name);}
  await test("cold avatars recover immutable textures without profile lookup", async function() {
    var env = environment();
    var results = await Promise.all([getAvatar(env, false), getAvatar(env, true)]);
    results.forEach(function(result){assert.deepStrictEqual(result.img, avatar); assert.strictEqual(result.hash, hash);});
    assert.strictEqual(env.downloads(), 1); assert.strictEqual(env.profiles(), 0);
  });
  await test("missing overlay is regenerated from an existing skin", async function() {
    var env = environment({files: ["skins/" + hash + ".png", "faces/" + hash + ".png"]});
    await getAvatar(env, true); assert.strictEqual(env.downloads(), 0); assert.strictEqual(env.profiles(), 0);
  });
  await test("skins with no overlay retain their actual face", async function() {
    var env = environment({noHelm: true}); await getAvatar(env, true); assert.strictEqual(env.profiles(), 0);
  });
  await test("texture failure propagates without profile lookup or replacement avatar", async function() {
    var failure = Object.assign(new Error("texture unavailable"), {code: "HTTPERROR"});
    var env = environment({failure: failure});
    await assert.rejects(getAvatar(env, true), function(err){return err === failure;});
    assert.strictEqual(env.profiles(), 0);
  });
  await test("skin and cape restore local files from fresh shared hashes", async function() {
    var env = environment();
    for (var method of ["get_skin", "get_cape"]) await new Promise(function(resolve, reject) {
      env.helpers[method]("test", uuid, function(err, resultHash, status, img) {
        if (err) return reject(err); assert.strictEqual(resultHash, hash); assert.deepStrictEqual(img, skin); resolve();
      });
    });
    assert.strictEqual(env.downloads(), 2); assert.strictEqual(env.profiles(), 0);
  });
  await test("rate limited refresh preserves stale hash, slim model, and long cooldown", async function() {
    var env = environment({stale: true});
    env.helpers.get_image_hash("test", uuid, "skin", function(err, status, resultHash, slim) {
      assert.strictEqual(err.code, "RATELIMIT"); assert.strictEqual(status, 4);
      assert.strictEqual(resultHash, hash); assert.strictEqual(slim, true);
    });
    assert.strictEqual(env.timestamp(), false);
  });
  await test("local ENOENT on every image route preserves shared metadata and reports failure", async function() {
    var failure = Object.assign(new Error("missing local image"), {code: "ENOENT"});
    for (var route of ["avatars", "skins", "capes", "renders"]) {
      var routeConfig = {avatars: {min_size: 1, max_size: 512, default_size: 64}, renders: {min_scale: 1, max_scale: 10, default_scale: 2}};
      var routeHelpers = {id_valid: function(){return true;}, is_skin_hash: function(){return false;}};
      routeHelpers.get_avatar = function() {arguments[arguments.length - 1](failure, -1, null, hash);};
      routeHelpers.get_render = function() {arguments[arguments.length - 1](failure, -1, hash, null);};
      routeHelpers.get_skin = routeHelpers.get_cape = function() {arguments[arguments.length - 1](failure, hash, -1, null);};
      var handler = load("lib/routes/" + route + ".js", {
        "../../config": routeConfig, "../helpers": routeHelpers, "../logging": logger,
        "../cache": {remove_hash: function(){assert.fail("local file loss must not delete shared metadata");}},
        "../skins": {default_skin: function(){return "mhf_steve";}, resize_img: function(file, size, cb){cb(null, avatar);}},
        "../renders": {draw_model: function(){arguments[arguments.length - 1](null, avatar);}},
        fs: {readFile: function(file, cb){cb(null, skin);}},
        "@randy.tarampi/lwip": {open: function(file, cb){cb(null, {toBuffer: function(format, cb){cb(null, skin);}});}}
      });
      var parsed = new URL("https://example.com/" + route + "/" + (route === "renders" ? "head/" : "") + uuid);
      parsed.path_list = parsed.pathname.split("/").slice(1);
      var callbacks = 0;
      handler({id: "test", url: parsed}, function(result){callbacks++; assert.strictEqual(result.err, failure);});
      assert.strictEqual(callbacks, 1);
    }
  });
  await test("actual HTTP 429 is classified as rate limited", async function() {
    var networking = load("lib/networking.js", {
      "./skins": {}, "./object-patch": {},
      fetch: async function() {return {status: 429, headers: [], arrayBuffer: async function() {return Buffer.from("retry later");}};}
    });
    await new Promise(function(resolve, reject) {
      networking.get_from("test", "https://sessionserver.mojang.com/session/minecraft/profile/" + uuid, function(body, response, err) {
        try {assert.strictEqual(body, null); assert.strictEqual(err.code, "RATELIMIT"); resolve();}
        catch (failure) {reject(failure);}
      });
    });
  });
  await test("fetch keeps binary textures, status errors, timeout and manual redirects", async function() {
    for (var status of [200, 302, 404, 503]) {
      var networking = load("lib/networking.js", {
        "./skins": {}, "./object-patch": {},
        fetch: async function(url, options) {
          assert.strictEqual(options.redirect, "manual");
          assert.strictEqual(options.signal.aborted, false);
          return {status: status, headers: [], arrayBuffer: async function() {return skin;}};
        }
      });
      await new Promise(function(resolve, reject) {
        networking.get_from("test", "https://textures.minecraft.net/texture/" + hash, function(body, response, err) {
          try {
            assert.strictEqual(response.statusCode, status);
            if (status === 200 || status === 302) assert.deepStrictEqual(body, skin);
            else assert.strictEqual(body, null);
            assert.strictEqual(!!err, status === 503);
            resolve();
          } catch (failure) {reject(failure);}
        });
      });
    }
    var timeout = Object.assign(new Error("timed out"), {name: "TimeoutError"});
    var failed = load("lib/networking.js", {"./skins": {}, "./object-patch": {}, fetch: async function() {throw timeout;}});
    await new Promise(function(resolve, reject) {
      failed.get_from("test", "https://textures.minecraft.net/texture/" + hash, function(body, response, err) {
        try {assert.strictEqual(body, null); assert.strictEqual(err, timeout); resolve();}
        catch (failure) {reject(failure);}
      });
    });
  });
  await test("malformed profile JSON is an error rather than a missing skin", async function() {
    var networking = load("lib/networking.js", {
      "./skins": {}, "./object-patch": {},
      fetch: async function() {return {status: 200, headers: [], arrayBuffer: async function() {return Buffer.from("invalid JSON");}};}
    });
    await new Promise(function(resolve, reject) {
      networking.get_profile("test", uuid, function(err, profile) {
        try {assert.strictEqual(err.name, "SyntaxError"); assert.strictEqual(profile, null); resolve();}
        catch (failure) {reject(failure);}
      });
    });
  });
  await test("render slim override reads WHATWG query parameters", async function() {
    for (var query of ["?slim=1", "?slim=0", ""]) {
      var expected = query === "" ? null : query === "?slim=1";
      var handler = load("lib/routes/renders.js", {
        "../logging": logger, "../renders": {}, "../skins": {},
        "../../config": {renders: {default_scale: 6, min_scale: 1, max_scale: 10}},
        "../helpers": {
          id_valid: function() {return true;},
          get_render: function(rid, id, scale, slim, overlay, body, cb) {
            assert.strictEqual(slim, expected);
            cb(null, 1, hash, avatar);
          }
        }
      });
      var parsed = new URL("https://crafatar.test/renders/body/" + uuid + query);
      parsed.path_list = ["renders", "body", uuid];
      var callbacks = 0;
      handler({id: "test", url: parsed}, function(result) {callbacks++; assert.strictEqual(result.body, avatar);});
      assert.strictEqual(callbacks, 1);
    }
  });
  await test("ephemeral startup never flushes Redis and temporary timestamps expire after 60 seconds", async function() {
    var written, redis = {
      on: function(event, cb) {if (event === "ready") cb();},
      flushall: function() {assert.fail("must not flush shared Redis");},
      hmset: function(id, key, value, cb) {written = value; cb(null);}
    };
    var cache = load("lib/cache.js", {redis: {createClient: function(){return redis;}}});
    var now = Date.now();
    cache.update_timestamp("test", uuid, true, function(err){assert.ifError(err);});
    assert(Math.abs(written + config.caching.local * 1000 - now - 60000) < 100);
  });
  console.log(count + " cache regression tests passed");
}
main().catch(function(err){console.error(err); process.exitCode = 1;});
