/** Snapshot File objects while clipboard access is valid. Do not fetch HTML
 * image URLs or interfere with an ordinary text paste. */
export function clipboardImages(data: DataTransfer): File[] {
  const image = (file: File) => file.type.startsWith('image/')
    || (!file.type || file.type === 'application/octet-stream') && /\.(png|jpe?g|gif|webp)$/i.test(file.name);
  const files = Array.from(data.items ?? []).filter(item => item.kind === 'file')
    .map(item => item.getAsFile()).filter((file): file is File => !!file && image(file));
  return files.length ? files : Array.from(data.files ?? []).filter(image);
}
