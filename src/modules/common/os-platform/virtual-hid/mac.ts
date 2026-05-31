import { Effect, Option, pipe } from "effect";
import { JSCallback, dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import type { Pointer } from "bun:ffi";

// FIDO Alliance usage page (0xF1D0), 64-byte in/out reports, no report IDs
const FIDO2_HID_DESCRIPTOR = new Uint8Array([
  0x06, 0xD0, 0xF1, // Usage Page (FIDO Alliance 0xF1D0, little-endian)
  0x09, 0x01,       // Usage (U2F HID Authenticator Device)
  0xA1, 0x01,       // Collection (Application)
  0x09, 0x20,       //   Usage (Input report data)
  0x15, 0x00,       //   Logical Minimum (0)
  0x26, 0xFF, 0x00, //   Logical Maximum (255)
  0x75, 0x08,       //   Report Size (8 bits)
  0x95, 0x40,       //   Report Count (64)
  0x81, 0x02,       //   Input (Data, Variable, Absolute)
  0x09, 0x21,       //   Usage (Output report data)
  0x15, 0x00,       //   Logical Minimum (0)
  0x26, 0xFF, 0x00, //   Logical Maximum (255)
  0x75, 0x08,       //   Report Size (8 bits)
  0x95, 0x40,       //   Report Count (64)
  0x91, 0x02,       //   Output (Data, Variable, Absolute)
  0xC0,             // End Collection
]);

const kIOHIDReportTypeOutput = 1;
const kIOReturnSuccess = 0;
const kCFStringEncodingUTF8 = 0x08000100;
const kCFPropertyListImmutable = 0;

// Kept at module scope to prevent GC while the virtual device is running
let _vhidCallback: JSCallback | null = null;

const fromPtr = (label: string, p: Pointer | null): Effect.Effect<Pointer, string> =>
  pipe(
    Option.fromNullishOr(p),
    Effect.fromOption,
    Effect.mapError(() => `${label} returned NULL`),
  );

// Build the device properties as an XML plist. CFPropertyListCreateWithData parses this
// into a fully-initialized CFDictionary (with correct hash/equal callbacks), avoiding
// the need to pass raw CFDictionaryKeyCallBacks structs via FFI.
function buildDevicePropertiesPlist(): Uint8Array {
  const descriptorB64 = Buffer.from(FIDO2_HID_DESCRIPTOR).toString('base64');
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>ReportDescriptor</key>',
    `  <data>${descriptorB64}</data>`,
    '  <key>VendorID</key>',
    '  <integer>4617</integer>',   // 0x1209 - pid.codes open-source VID
    '  <key>ProductID</key>',
    '  <integer>1</integer>',
    '  <key>VersionNumber</key>',
    '  <integer>256</integer>',    // 0x0100
    '  <key>Product</key>',
    '  <string>Ozy Virtual FIDO2 Key</string>',
    '</dict>',
    '</plist>',
  ].join('\n');
  return new TextEncoder().encode(xml);
}

export function registerVirtualHIDMac(
  onMessage: (data: Buffer) => Effect.Effect<Buffer>
): Effect.Effect<void, string> {
  return Effect.gen(function* () {
    console.log('[vhid] loading frameworks');

    const IOKit = yield* Effect.try({
      try: () => dlopen('/System/Library/Frameworks/IOKit.framework/IOKit', {
        IOHIDUserDeviceCreate: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
        IOHIDUserDeviceRegisterSetReportCallback: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
        IOHIDUserDeviceScheduleWithRunLoop: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.void },
        IOHIDUserDeviceHandleReport: { args: [FFIType.ptr, FFIType.ptr, FFIType.i64], returns: FFIType.i32 },
      }),
      catch: (e) => `Failed to load IOKit: ${e}`,
    });

    const CF = yield* Effect.try({
      try: () => dlopen('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation', {
        CFRunLoopGetCurrent: { args: [], returns: FFIType.ptr },
        CFRunLoopRunInMode: { args: [FFIType.ptr, FFIType.f64, FFIType.bool], returns: FFIType.i32 },
        CFStringCreateWithCString: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
        CFDataCreate: { args: [FFIType.ptr, FFIType.ptr, FFIType.i64], returns: FFIType.ptr },
        CFPropertyListCreateWithData: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
        CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
      }),
      catch: (e) => `Failed to load CoreFoundation: ${e}`,
    });

    console.log('[vhid] frameworks loaded');

    const encoder = new TextEncoder();

    const makeCFString = (s: string): Effect.Effect<Pointer, string> =>
      // TextEncoder gives a Uint8Array with its own ArrayBuffer (byteOffset=0, pool-safe)
      fromPtr(`CFStringCreateWithCString("${s}")`,
        CF.symbols.CFStringCreateWithCString(null, ptr(encoder.encode(s + '\0')), kCFStringEncodingUTF8));

    const makeCFData = (data: Uint8Array): Effect.Effect<Pointer, string> =>
      fromPtr('CFDataCreate', CF.symbols.CFDataCreate(null, ptr(data), BigInt(data.length)));

    console.log('[vhid] building device properties plist');
    const plistBytes = buildDevicePropertiesPlist();
    const plistData = yield* makeCFData(plistBytes);

    const dict = yield* fromPtr('CFPropertyListCreateWithData',
      CF.symbols.CFPropertyListCreateWithData(null, plistData, BigInt(kCFPropertyListImmutable), null, null));
    CF.symbols.CFRelease(plistData);
    console.log('[vhid] device properties dict =', dict);

    console.log('[vhid] creating IOHIDUserDevice');
    const device = yield* fromPtr('IOHIDUserDeviceCreate', IOKit.symbols.IOHIDUserDeviceCreate(null, dict));
    CF.symbols.CFRelease(dict);
    console.log('[vhid] IOHIDUserDeviceCreate =', device);

    const callback = yield* Effect.try({
      try: () => new JSCallback(
        (_refcon: number, _result: number, _sender: number, type: number, _reportID: number, report: number, reportLength: number) => {
          if (type !== kIOHIDReportTypeOutput) return kIOReturnSuccess;
          const incoming = Buffer.from(toArrayBuffer(report as unknown as Pointer, 0, reportLength));
          console.log(`[vhid] received ${incoming.length} bytes: ${incoming.toString('hex')}`);
          Effect.runPromise(onMessage(incoming)).then(response => {
            const responseBuf = new Uint8Array(64);
            response.copy(Buffer.from(responseBuf.buffer), 0, 0, Math.min(response.length, 64));
            IOKit.symbols.IOHIDUserDeviceHandleReport(device, ptr(responseBuf), BigInt(responseBuf.length));
          }).catch(() => {});
          return kIOReturnSuccess;
        },
        { returns: 'i32', args: ['ptr', 'i32', 'ptr', 'i32', 'u32', 'ptr', 'i64'] },
      ),
      catch: (e) => `Failed to create JSCallback: ${e}`,
    });
    _vhidCallback = callback;

    IOKit.symbols.IOHIDUserDeviceRegisterSetReportCallback(device, callback.ptr, null);

    const runLoop = CF.symbols.CFRunLoopGetCurrent();
    const runLoopMode = yield* makeCFString('kCFRunLoopDefaultMode');
    IOKit.symbols.IOHIDUserDeviceScheduleWithRunLoop(device, runLoop, runLoopMode);

    console.log('[vhid] virtual FIDO2 device active, pumping run loop');
    // Pump CFRunLoop from Bun's libuv event loop without blocking
    setInterval(() => CF.symbols.CFRunLoopRunInMode(runLoopMode, 0.0, false), 10);
  });
}
