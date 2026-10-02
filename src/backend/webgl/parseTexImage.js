import { isValidDimension } from '../../shared/dimensions.js';

export const parseTexImageArgs = (args) => {
  let width;
  let height;
  let image;
  let internalFormat;
  let pixelType;

  if (args.length === 6) {
    internalFormat = args[2];
    pixelType = args[4];
    image = args[5];
  } else if (args.length >= 9) {
    internalFormat = args[2];
    width = args[3];
    height = args[4];
    pixelType = args[7];
    image = args[8];
  }

  if (image && typeof image === 'number') image = null;

  if (image && (image.width || image.videoWidth || image.naturalWidth)) {
    width = image.width ?? image.videoWidth ?? image.naturalWidth;
    height = image.height ?? image.videoHeight ?? image.naturalHeight;
  }

  if (!isValidDimension(width)) width = undefined;
  if (!isValidDimension(height)) height = undefined;

  return { width, height, image, internalFormat, pixelType };
};
