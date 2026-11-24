from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def generate_icons():
    size = 512
    image = Image.new("RGBA", (size, size))
    pixels = image.load()
    stops = [(0, (29, 78, 216)), (0.48, (37, 99, 235)), (1, (6, 182, 212))]
    for vertical in range(size):
        for horizontal in range(size):
            position = min(1, max(0, ((horizontal - 96) * 334 + (vertical - 72) * 358) / (334 ** 2 + 358 ** 2)))
            first, second = (stops[0], stops[1]) if position < 0.48 else (stops[1], stops[2])
            weight = (position - first[0]) / (second[0] - first[0])
            color = tuple(round(start + (end - start) * weight) for start, end in zip(first[1], second[1]))
            pixels[horizontal, vertical] = (*color, 255)
    mask = Image.new("L", (size, size))
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, 511, 511), radius=112, fill=255)
    image.putalpha(mask)
    font = ImageFont.truetype("DejaVuSans-Bold.ttf", 140)
    ImageDraw.Draw(image).text((256, 256), "AOD", font=font, anchor="mm", fill="#fffefa")
    public = Path(__file__).resolve().parent.parent / "apps" / "web" / "public"
    for target_size in (180, 192, 512):
        image.resize((target_size, target_size), Image.Resampling.LANCZOS).save(public / f"pwa-icon-{target_size}.png")
    root = public.parents[2]
    image.resize((1024, 1024), Image.Resampling.LANCZOS).save(root / "apps/ios/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png")
    image.save(root / "native/windows/assets/AgentOpsDeck.ico", sizes=[(32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


if __name__ == "__main__":
    generate_icons()
