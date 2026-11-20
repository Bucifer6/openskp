# TIFF texture fixtures

Small TIFF images written by Pillow (Python Imaging Library) 12.3, used by
`tests/simplify-and-textures.test.ts` to check the TIFF texture decoder
against an encoder this project did not write.

| File | Contents |
|:---|:---|
| `rgb_none.tif` | 24 x 16 RGB gradient, uncompressed |
| `rgb_lzw.tif`, `rgb_deflate.tif`, `rgb_packbits.tif` | the same picture, compressed |
| `rgb_jpeg.tif` | the same picture as JPEG-in-TIFF, which the decoder does not read |
| `big_none.tif` | 160 x 120 noisy RGB, uncompressed |
| `big_lzw.tif` | the same picture: enough data for LZW codes to reach 12 bits and reset |
| `big_lzw_predictor.tif` | the same picture, LZW with horizontal differencing |
| `rgba_none.tif`, `rgba_lzw.tif` | 24 x 16 RGBA, alpha 255 on the left half and 96 on the right |
| `gray_none.tif` | 24 x 16 greyscale |
| `palette_lzw.tif` | 16-colour palette image; `palette_expected.tif` is the same picture as RGB |
