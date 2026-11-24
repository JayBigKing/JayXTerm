#import <AppKit/AppKit.h>
#include <node_api.h>
#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

static NSString *const kWebCustomData = @"org.chromium.web-custom-data";

@interface FinderPromise : NSFilePromiseProvider
@property(copy) NSData *relayData;
@end

@implementation FinderPromise
- (NSArray<NSPasteboardType> *)writableTypesForPasteboard:(NSPasteboard *)pasteboard {
  return [[super writableTypesForPasteboard:pasteboard] arrayByAddingObject:kWebCustomData];
}
- (id)pasteboardPropertyListForType:(NSPasteboardType)type {
  return [type isEqualToString:kWebCustomData]
    ? self.relayData : [super pasteboardPropertyListForType:type];
}
- (NSPasteboardWritingOptions)writingOptionsForType:(NSPasteboardType)type
                                         pasteboard:(NSPasteboard *)pasteboard {
  return [type isEqualToString:kWebCustomData]
    ? 0 : [super writingOptionsForType:type pasteboard:pasteboard];
}
@end

using Completion = void (^)(NSError *);
struct WriteRequest {
  std::string path;
  Completion completion;
};

static void Finish(WriteRequest *request, NSString *message) {
  if (!request->completion) return;
  Completion completion = request->completion;
  request->completion = nil;
  completion(message ? [NSError errorWithDomain:@"JayXTermFinderDrag" code:1
                                        userInfo:@{NSLocalizedDescriptionKey: message}] : nil);
}

static std::string StringValue(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return {};
  std::string result(length + 1, '\0');
  napi_get_value_string_utf8(env, value, result.data(), result.size(), &length);
  result.resize(length);
  return result;
}

static napi_value Complete(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value arg;
  void *data = nullptr;
  napi_get_cb_info(env, info, &count, &arg, nullptr, &data);
  const auto error = count ? StringValue(env, arg) : std::string();
  Finish(static_cast<WriteRequest *>(data), error.empty() ? nil : @(error.c_str()));
  return nullptr;
}

static void CallWriter(napi_env env, napi_value callback, void *, void *data) {
  auto *request = static_cast<WriteRequest *>(data);
  if (!env || !callback) {
    Finish(request, @"JayXTerm 已退出");
    delete request;
    return;
  }
  napi_value args[2];
  napi_create_string_utf8(env, request->path.c_str(), request->path.size(), &args[0]);
  napi_create_function(env, "completeFinderDrop", NAPI_AUTO_LENGTH, Complete, request, &args[1]);
  napi_add_finalizer(env, args[1], request, [](napi_env, void *ptr, void *) {
    auto *pending = static_cast<WriteRequest *>(ptr);
    Finish(pending, @"拖放未完成");
    delete pending;
  }, nullptr, nullptr);
  napi_value receiver;
  napi_get_undefined(env, &receiver);
  if (napi_call_function(env, receiver, callback, 2, args, nullptr) != napi_ok)
    Finish(request, @"无法启动文件下载");
}

@interface FinderDragSource : NSObject <NSDraggingSource, NSFilePromiseProviderDelegate>
@property(copy) NSString *name;
@property(assign) napi_threadsafe_function writer;
@end

@implementation FinderDragSource
- (void)dealloc {
  if (_writer) napi_release_threadsafe_function(_writer, napi_tsfn_release);
}
- (NSDragOperation)draggingSession:(NSDraggingSession *)session
       sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
  return NSDragOperationCopy;
}
- (NSOperationQueue *)operationQueueForFilePromiseProvider:(NSFilePromiseProvider *)provider {
  static NSOperationQueue *queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ queue = [NSOperationQueue new]; });
  return queue;
}
- (NSString *)filePromiseProvider:(NSFilePromiseProvider *)provider fileNameForType:(NSString *)type {
  return self.name;
}
- (void)filePromiseProvider:(NSFilePromiseProvider *)provider writePromiseToURL:(NSURL *)url
          completionHandler:(Completion)completion {
  const char *file = url.fileSystemRepresentation;
  if (!url.isFileURL || !file) {
    completion([NSError errorWithDomain:@"JayXTermFinderDrag" code:2 userInfo:nil]);
    return;
  }
  auto *request = new WriteRequest{file, [completion copy]};
  if (napi_call_threadsafe_function(self.writer, request, napi_tsfn_nonblocking) != napi_ok) {
    Finish(request, @"无法启动文件下载");
    delete request;
  }
}
@end

static id dragMonitor;

static void StopMonitoring() {
  if (dragMonitor) [NSEvent removeMonitor:dragMonitor];
  dragMonitor = nil;
}

static bool BeginDrag(NSView *view, NSEvent *event, FinderPromise *promise,
                      FinderDragSource *source, bool directory) {
  auto *item = [[NSDraggingItem alloc] initWithPasteboardWriter:promise];
  auto *icon = [NSImage imageNamed:directory ? NSImageNameFolder : NSImageNameMultipleDocuments];
  const NSPoint point = [view convertPoint:event.locationInWindow fromView:nil];
  [item setDraggingFrame:NSMakeRect(point.x - 16, point.y - 16, 32, 32) contents:icon];
  @try {
    return [view beginDraggingSessionWithItems:@[item] event:event source:source] != nil;
  } @catch (NSException *exception) {
    NSLog(@"JayXTerm: Finder drag could not start (%@)", exception.name);
    return false;
  }
}

static napi_value BooleanValue(napi_env env, bool result) {
  napi_value value;
  napi_get_boolean(env, result, &value);
  return value;
}

static napi_value Arm(napi_env env, napi_callback_info info) {
  size_t count = 5;
  napi_value args[5];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 5) return nullptr;
  void *handle = nullptr;
  size_t bytes = 0;
  void *pointer = nullptr;
  if (napi_get_buffer_info(env, args[0], &handle, &bytes) != napi_ok || bytes != sizeof(pointer))
    return nullptr;
  void *relayBytes = nullptr;
  size_t relaySize = 0;
  if (napi_get_buffer_info(env, args[3], &relayBytes, &relaySize) != napi_ok)
    return nullptr;
  std::memcpy(&pointer, handle, sizeof(pointer));
  NSView *view = (__bridge NSView *)pointer;
  NSWindow *window = view.window;
  if (!window) {
    napi_throw_error(env, "FINDER_WINDOW_UNAVAILABLE", "拖放窗口已关闭");
    return nullptr;
  }
  StopMonitoring();
  NSEvent *current = NSApp.currentEvent;
  const bool fromSourceWindow = current.windowNumber == window.windowNumber;
  const bool justPressed = fromSourceWindow && current.type == NSEventTypeLeftMouseDown;
  const bool alreadyDragging = fromSourceWindow && current.type == NSEventTypeLeftMouseDragged;
  if (!justPressed && !alreadyDragging && !(NSEvent.pressedMouseButtons & 1))
    return BooleanValue(env, false);

  const auto filename = StringValue(env, args[1]);
  bool directory = false;
  napi_get_value_bool(env, args[2], &directory);
  auto *source = [FinderDragSource new];
  source.name = @(filename.c_str());
  napi_value resource;
  napi_create_string_utf8(env, "Finder file promise", NAPI_AUTO_LENGTH, &resource);
  napi_threadsafe_function writer = nullptr;
  if (napi_create_threadsafe_function(env, args[4], nullptr, resource, 0, 1,
      nullptr, nullptr, nullptr, CallWriter, &writer) != napi_ok) {
    napi_throw_error(env, "FINDER_CALLBACK", "无法创建 Finder 拖放会话");
    return nullptr;
  }
  source.writer = writer;
  napi_unref_threadsafe_function(env, writer);
  auto *promise = [[FinderPromise alloc] initWithFileType:directory ? @"public.folder" : @"public.data"
                                               delegate:source];
  promise.relayData = [NSData dataWithBytes:relayBytes length:relaySize];
  // The provider's delegate is weak. Keep the source alive for promise fulfillment.
  promise.userInfo = source;
  if (alreadyDragging)
    return BooleanValue(env, BeginDrag(view, current, promise, source, directory));

  // Capture the next AppKit drag event while the originating mouse press is
  // still active. A normal click drops through and never requests a file.
  const NSPoint origin = justPressed ? current.locationInWindow : window.mouseLocationOutsideOfEventStream;
  __weak NSView *weakView = view;
  dragMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:
      NSEventMaskLeftMouseDragged | NSEventMaskLeftMouseUp | NSEventMaskLeftMouseDown
      handler:^NSEvent *(NSEvent *event) {
    NSView *dragView = weakView;
    if (!dragView.window || event.type != NSEventTypeLeftMouseDragged) {
      StopMonitoring();
      return event;
    }
    if (event.windowNumber != dragView.window.windowNumber) return event;
    const NSPoint location = event.locationInWindow;
    if (std::max(std::abs(location.x - origin.x), std::abs(location.y - origin.y)) < 4)
      return event;
    const bool started = BeginDrag(dragView, event, promise, source, directory);
    StopMonitoring();
    return started ? nil : event;
  }];
  return BooleanValue(env, dragMonitor != nil);
}

static napi_value Publish(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 2) return nullptr;
  const auto source = StringValue(env, args[0]);
  const auto target = StringValue(env, args[1]);
  if (renamex_np(source.c_str(), target.c_str(), RENAME_EXCL) != 0)
    napi_throw_error(env, errno == EEXIST ? "EEXIST" : nullptr, std::strerror(errno));
  return nullptr;
}

NAPI_MODULE_INIT() {
  const napi_property_descriptor methods[] = {
    {"arm", nullptr, Arm, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"publish", nullptr, Publish, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, methods);
  return exports;
}
