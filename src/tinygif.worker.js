import NeuQuant from "./NeuQuant"

function dataToRGB(data, width, height) {
  var i = 0;
  var length = width * height * 4;
  var rgb = [];

  while(i < length) {
    rgb.push( data[i++] );
    rgb.push( data[i++] );
    rgb.push( data[i++] );
    i++; // for the alpha channel which we don't care about
  }

  return rgb;
}

function componentizedPaletteToArray(paletteRGB) {
  var paletteArray = [];

  for(var i = 0; i < paletteRGB.length; i += 3) {
    var r = paletteRGB[ i ];
    var g = paletteRGB[ i + 1 ];
    var b = paletteRGB[ i + 2 ];
    paletteArray.push(r << 16 | g << 8 | b);
  }

  return paletteArray;
}

function dirtyRect(previousData, imageData, width, height) {
  var result = {
    x: 0,
    y: 0,
    width: width,
    height: height
  }

  if (!previousData) {
    return result
  }

  var left = -1, right = -1, top = -1, bottom = -1;

  for (var i = 0, l = previousData.length; i < l; i++) {
    if (previousData[i] !== imageData[i]) {
      top = Math.floor(i / (width * 4));
      break
    }
  }

  // There is no delta, all pixels match
  if (top == -1) {
    return null
  }

  for (var i = previousData.length - 1; i > -1; i--) {
    if (previousData[i] !== imageData[i]) {
      bottom = Math.floor(i / (width * 4));
      break
    }
  }

  for (var x = 0; x < (width * 4); x += 4) {
    for (var y = 0; y < height; y++) {
      var pos = (y * (width * 4)) + x;
      if (previousData[pos] !== imageData[pos] ||
        previousData[pos + 1] !== imageData[pos + 1] ||
        previousData[pos + 2] !== imageData[pos + 2] ||
        previousData[pos + 3] !== imageData[pos + 3]) {
        left = x / 4;
        break
      }
    }
    if (left > -1) break;
  }

  for (var x = ((width - 1) * 4); x > -1; x -= 4) {
    for (var y = 0; y < height; y++) {
      var pos = (y * (width * 4)) + x;
      if (previousData[pos] !== imageData[pos] ||
        previousData[pos + 1] !== imageData[pos + 1] ||
        previousData[pos + 2] !== imageData[pos + 2] ||
        previousData[pos + 3] !== imageData[pos + 3]) {
        right = x / 4;
        break
      }
    }
    if (right > -1) break;
  }

  return {
    x: left,
    y: top,
    width: (right - left) + 1,
    height: (bottom - top) + 1
  }
}

function run(data) {
  var frame = data.frame;
  var previous = data.previous;
  var palette = data.palette;
  var quantizer = data.quantizer;

  var previousData = previous ? previous.data : null;
  var imageData = frame.data;
  var width = frame.width;
  var height = frame.height;
  var sampleInterval = frame.sampleInterval;

  // Find the delta
  var delta = dirtyRect(previousData, imageData, width, height);
  if (!delta) {
    return {
      skip: true
    }
  }

  // Grab only the changed portion and work with that
  var deltaImageData = new Uint8ClampedArray(delta.width * delta.height * 4)
  var deltaIndex = 0;
  for (var y = delta.y; y < delta.y + delta.height; y++) {
    var start = (y * width * 4) + (delta.x * 4);
    var end = (y * width * 4) + (delta.x * 4) + (delta.width  * 4);
    for (var i = start; i < end; i++) {
      deltaImageData[deltaIndex++] = imageData[i];
    }
  }

  // Prepare an index array into the palette
  var numberPixels = delta.width * delta.height;
  var indexedPixels = new Uint8Array(numberPixels);
  var pixel = 0
  var colorsArray = [];
  var colorsHash = {};

  // If we can use the global palette directly let's do it... even if we have
  // to add a couple more colors, unless it is a quantized palette because
  // we would need to map the colors
  if (palette && !quantizer) {
    var globalPaletteMatches = true
    // Build a quick lookup table, TODO... pass this around
    for (var i = 0, l = palette.length; i < l; i++) {
      colorsHash[palette[i]] = i;
    }
    for (var i = 0, l = deltaImageData.length; i < l; i+=4){
      var r = deltaImageData[i];
      var g = deltaImageData[i + 1];
      var b = deltaImageData[i + 2];
      // Ignore the alpha channel
      var color = (0 << 24 | r << 16 | g << 8 | b);
      var foundIndex = colorsHash[color];
      // If we didn't find it on the global palette, is there room to add it?
      if (foundIndex == null && palette.length == 255) {
        globalPaletteMatches = false;
        break;
      }
      if (foundIndex == null) {
        palette.push(color);
        foundIndex = palette.length - 1;
        colorsHash[color] = foundIndex;
      }
      indexedPixels[pixel++] = foundIndex;
    }

    if (globalPaletteMatches) {
      return {
        delta: delta,
        pixels: indexedPixels,
        global: true, // assign this to global palette
        palette: palette
      };
    }
  }

  // We couldn't use the global palette, try to create a local palette instead
  // Grabbing the unique colors and just using them is way more efficient, but
  // it doesn't work for images > 256 colors; we'll be optimisitic about it
  colorsArray = [];
  colorsHash = {};
  pixel = 0
  for (var i = 0, l = deltaImageData.length; i < l; i+=4){
    var r = deltaImageData[i];
    var g = deltaImageData[i + 1];
    var b = deltaImageData[i + 2];
    // Ignore the alpha channel
    var color = (0 << 24 | r << 16 | g << 8 | b);
    var foundIndex = colorsHash[color];
    if (foundIndex == null) {
      colorsArray.push(color);
      foundIndex = colorsArray.length - 1;
      // If there are already too many colors, just bail on this approach
      if (foundIndex >= 256) break;
      colorsHash[color] = foundIndex;
    }
    indexedPixels[pixel++] = foundIndex;
  }

  if (colorsArray.length < 256) {
    return {
      delta: delta,
      pixels: indexedPixels,
      palette: colorsArray
    };
  }

  // This is the "traditional" animatied gif style of going from RGBA to
  // indexed color frames via sampling

  var rgbComponents = dataToRGB(deltaImageData, delta.width, delta.height);
  var nq = new NeuQuant(rgbComponents, rgbComponents.length, sampleInterval || 10);
  var paletteRGB = nq.process();
  var paletteArray = componentizedPaletteToArray(paletteRGB);

  var k = 0;
  for(var i = 0; i < numberPixels; i++) {
    r = rgbComponents[k++];
    g = rgbComponents[k++];
    b = rgbComponents[k++];
    indexedPixels[i] = nq.map(r, g, b);
  }

  return {
    delta: delta,
    pixels: indexedPixels,
    palette: paletteArray,
    quantizer: true
  };
}

self.onmessage = function(message) {
  var data = message.data;
  var response = run(data);
  postMessage(response);
};
