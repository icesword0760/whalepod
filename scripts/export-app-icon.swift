import AppKit
// Apply the macOS rounded-tile export mask to the approved generated artwork.
// No changes to interior artwork. Keep all raster fragments outside the tile out of exports.
let root = CommandLine.arguments[1]
let source = NSImage(contentsOfFile: root + "/assets/app-icon/source.png")!
source.size = NSSize(width: 1254, height: 1254)
let out = root + "/assets/app-icon"
let fm = FileManager.default
try fm.createDirectory(atPath: out + "/AppIcon.iconset", withIntermediateDirectories: true)
func export(_ size: Int, _ path: String) throws {
 let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
 NSGraphicsContext.saveGraphicsState()
 NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
 let scale = CGFloat(size) / 1024
 let transform = NSAffineTransform(); transform.scale(by: scale); transform.concat()
 let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
 NSBezierPath(roundedRect: tile, xRadius: 172, yRadius: 172).addClip()
 NSGraphicsContext.current?.imageInterpolation = .high
 // Inset the source rectangle slightly inside its original tile boundary.
 source.draw(in: tile, from: NSRect(x: 90, y: 107, width: 1072, height: 1036), operation: .copy, fraction: 1)
 NSGraphicsContext.restoreGraphicsState()
 try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}
try export(1024, out + "/AppIcon.png")
for size in [16,32,128,256,512] {
 try export(size, out + "/AppIcon.iconset/icon_\(size)x\(size).png")
 try export(size * 2, out + "/AppIcon.iconset/icon_\(size)x\(size)@2x.png")
}
print("Exported transparent master and 10 macOS icon sizes")
