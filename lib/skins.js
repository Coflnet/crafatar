var logging = require("./logging");
var cvs = require("canvas");
var fs = require("fs");
var exp = {};

exp.extract_face = function(buffer, outname, callback) {
  cvs.loadImage(buffer).then(function(image) {
    var canvas = cvs.createCanvas(8, 8);
    var ctx = canvas.getContext("2d");
    ctx.drawImage(image, 8, 8, 8, 8, 0, 0, 8, 8);
    var pixels = ctx.getImageData(0, 0, 8, 8);
    for (var i = 3; i < pixels.data.length; i += 4) pixels.data[i] = 255;
    ctx.putImageData(pixels, 0, 0);
    canvas.toBuffer(function(err, result) {
      if (err) return callback(err);
      fs.writeFile(outname, result, callback);
    });
  }).catch(callback);
};

exp.extract_helm = function(rid, facefile, buffer, outname, callback) {
  Promise.all([cvs.loadImage(buffer), cvs.loadImage(facefile)]).then(function(images) {
    var canvas = cvs.createCanvas(32, 32);
    var ctx = canvas.getContext("2d");
    ctx.drawImage(images[0], 32, 0, 32, 32, 0, 0, 32, 32);
    var pixels = ctx.getImageData(0, 0, 32, 32).data;
    var transparent = false;
    for (var i = 3; i < pixels.length; i += 4) {
      if (pixels[i] < 255) { transparent = true; break; }
    }
    if (!transparent) {
      logging.debug(rid, "Skin is not transparent, skipping helm!");
      return fs.copyFile(facefile, outname, callback);
    }
    var helm = cvs.createCanvas(8, 8);
    var helmCtx = helm.getContext("2d");
    helmCtx.drawImage(images[1], 0, 0);
    var before = Buffer.from(helmCtx.getImageData(0, 0, 8, 8).data);
    helmCtx.drawImage(images[0], 40, 8, 8, 8, 0, 0, 8, 8);
    if (before.equals(Buffer.from(helmCtx.getImageData(0, 0, 8, 8).data))) {
      logging.debug(rid, "helm img == face img, not storing!");
      return fs.copyFile(facefile, outname, callback);
    }
    helm.toBuffer(function(err, result) {
      if (err) return callback(err);
      fs.writeFile(outname, result, callback);
    });
  }).catch(callback);
};

exp.resize_img = function(inname, size, callback) {
  cvs.loadImage(inname).then(function(image) {
    var canvas = cvs.createCanvas(size, size);
    var ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, 0, 0, size, size);
    canvas.toBuffer(callback);
  }).catch(callback);
};

// returns "mhf_alex" or "mhf_steve" calculated by the +uuid+
exp.default_skin = function(uuid) {
  // great thanks to Minecrell for research into Minecraft and Java's UUID hashing!
  // https://git.io/xJpV
  // MC uses `uuid.hashCode() & 1` for alex
  // that can be compacted to counting the LSBs of every 4th byte in the UUID
  // an odd sum means alex, an even sum means steve
  // XOR-ing all the LSBs gives us 1 for alex and 0 for steve
  var lsbs_even = parseInt(uuid[ 7], 16) ^
                  parseInt(uuid[15], 16) ^
                  parseInt(uuid[23], 16) ^
                  parseInt(uuid[31], 16);
  return lsbs_even ? "mhf_alex" : "mhf_steve";
};

// helper method for opening a skin file from +skinpath+
// callback: error, image buffer
exp.open_skin = function(rid, skinpath, callback) {
  fs.readFile(skinpath, function(err, buf) {
    if (err) {
      callback(err, null);
    } else {
      callback(null, buf);
    }
  });
};

// Re-encode downloaded images before caching them.
exp.save_image = function(buffer, outpath, callback) {
  cvs.loadImage(buffer).then(function(image) {
    var canvas = cvs.createCanvas(image.width, image.height);
    canvas.getContext("2d").drawImage(image, 0, 0);
    canvas.toBuffer(function(err, result) {
      if (err) return callback(err);
      fs.writeFile(outpath, result, callback);
    });
  }).catch(callback);
};

module.exports = exp;
