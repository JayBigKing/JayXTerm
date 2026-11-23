#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <ole2.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <wincrypt.h>

#include <atomic>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace {
const CLIPFORMAT descriptors = RegisterClipboardFormatW(L"FileGroupDescriptorW");
const CLIPFORMAT contents = RegisterClipboardFormatW(L"FileContents");
const CLIPFORMAT preferredEffect = RegisterClipboardFormatW(L"Preferred DropEffect");
const CLIPFORMAT inDragLoop = RegisterClipboardFormatW(L"InShellDragLoop");
const CLIPFORMAT performedEffect = RegisterClipboardFormatW(L"Performed DropEffect");
const CLIPFORMAT logicalEffect = RegisterClipboardFormatW(L"Logical Performed DropEffect");
// This drag originates in our renderer. Chromium must use the relay token when
// it receives it, rather than materializing the Shell's virtual files first.
// These are the same conservative markers used by Chromium's Windows provider.
// See OSExchangeDataProviderWin and WebContentsViewAura::ShouldIncludeVirtualFiles.
const CLIPFORMAT rendererTaint = RegisterClipboardFormatW(L"chromium/x-renderer-taint");
const CLIPFORMAT ignoreFileContents = RegisterClipboardFormatW(L"chromium/x-ignore-file-contents");
constexpr uint64_t maxGlobalFile = 4 * 1024 * 1024;
// IDataObjectAsyncCapability, also called IAsyncOperation by older SDKs.
const IID asyncCapabilityId = {0x3d8b0590, 0xf691, 0x11d2, {0x8e, 0xa9, 0x00, 0x60, 0x97, 0xdf, 0x5b, 0xd4}};
struct AsyncCapability : IUnknown {
  virtual HRESULT STDMETHODCALLTYPE SetAsyncMode(BOOL) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetAsyncMode(BOOL *) = 0;
  virtual HRESULT STDMETHODCALLTYPE StartOperation(IBindCtx *) = 0;
  virtual HRESULT STDMETHODCALLTYPE InOperation(BOOL *) = 0;
  virtual HRESULT STDMETHODCALLTYPE EndOperation(HRESULT, IBindCtx *, DWORD) = 0;
};

std::vector<std::string> fields(const std::string &line) {
  std::vector<std::string> result;
  std::istringstream stream(line);
  for (std::string item; std::getline(stream, item, '\t');) result.push_back(std::move(item));
  return result;
}

std::wstring wide(const std::string &encoded) {
  DWORD bytes = 0;
  if (!CryptStringToBinaryA(encoded.data(), static_cast<DWORD>(encoded.size()),
                           CRYPT_STRING_BASE64, nullptr, &bytes, nullptr, nullptr)) return {};
  std::string raw(bytes, '\0');
  if (!CryptStringToBinaryA(encoded.data(), static_cast<DWORD>(encoded.size()),
                           CRYPT_STRING_BASE64, reinterpret_cast<BYTE *>(raw.data()),
                           &bytes, nullptr, nullptr)) return {};
  const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, raw.data(),
                                        static_cast<int>(bytes), nullptr, 0);
  if (!count) return {};
  std::wstring result(count, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, raw.data(),
                     static_cast<int>(bytes), result.data(), count);
  return result;
}

struct Entry {
  std::wstring name;
  bool directory;
  uint64_t bytes;
};

struct DragState {
  std::string token;
  std::wstring relayText;
  std::vector<Entry> entries;
  std::map<size_t, std::wstring> staged;
  bool manifestLoaded = false;
  bool dropped = false;
  bool cancelled = false;
  bool failed = false;

  bool loadManifest() {
    if (manifestLoaded) return true;
    if (failed) return false;
    std::cout << "manifest\t" << token << std::endl;
    std::string line;
    if (!std::getline(std::cin, line)) { failed = true; return false; }
    const auto header = fields(line);
    if (header.size() != 2 || header[0] != "entries") { failed = true; return false; }
    const unsigned long count = std::stoul(header[1]);
    std::vector<Entry> next;
    next.reserve(count);
    for (unsigned long i = 0; i < count; ++i) {
      if (!std::getline(std::cin, line)) { failed = true; return false; }
      const auto item = fields(line);
      if (item.size() != 3) { failed = true; return false; }
      auto name = wide(item[0]);
      if (name.empty() || name.size() >= MAX_PATH) { failed = true; return false; }
      next.push_back({std::move(name), item[1] == "1", std::stoull(item[2])});
    }
    entries = std::move(next);
    manifestLoaded = true;
    return true;
  }

  HRESULT openFile(size_t index, IStream **stream) {
    if (!dropped) return STG_E_ACCESSDENIED;
    if (failed) return STG_E_READFAULT;
    auto cached = staged.find(index);
    if (cached == staged.end()) {
      std::cout << "file\t" << token << '\t' << index << std::endl;
      std::string line;
      if (!std::getline(std::cin, line)) { failed = true; return STG_E_READFAULT; }
      const auto reply = fields(line);
      if (reply.size() != 2 || reply[0] != "path") { failed = true; return STG_E_READFAULT; }
      cached = staged.emplace(index, wide(reply[1])).first;
    }
    HRESULT result = SHCreateStreamOnFileEx(cached->second.c_str(), STGM_READ | STGM_SHARE_DENY_WRITE,
                                             FILE_ATTRIBUTE_NORMAL, FALSE, nullptr, stream);
    if (FAILED(result)) failed = true;
    return result;
  }
};

class RemoteStream final : public IStream {
  std::atomic<ULONG> refs{1};
  std::shared_ptr<DragState> state;
  size_t index;
  uint64_t position = 0;
  IStream *local = nullptr;

  HRESULT ensureLocal() {
    if (local) return S_OK;
    HRESULT result = state->openFile(index, &local);
    if (FAILED(result)) return result;
    LARGE_INTEGER offset{};
    offset.QuadPart = position;
    return local->Seek(offset, STREAM_SEEK_SET, nullptr);
  }

public:
  RemoteStream(std::shared_ptr<DragState> state, size_t index) : state(std::move(state)), index(index) {}
  ~RemoteStream() { if (local) local->Release(); }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void **object) override {
    *object = nullptr;
    if (iid != IID_IUnknown && iid != IID_ISequentialStream && iid != IID_IStream) return E_NOINTERFACE;
    *object = static_cast<IStream *>(this);
    AddRef();
    return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG remaining = --refs;
    if (!remaining) delete this;
    return remaining;
  }
  HRESULT STDMETHODCALLTYPE Read(void *buffer, ULONG count, ULONG *actual) override {
    if (actual) *actual = 0;
    if (!count) return S_OK;
    if (position >= state->entries[index].bytes) return S_FALSE;
    const HRESULT result = ensureLocal();
    if (FAILED(result)) return result;
    ULONG read = 0;
    const HRESULT status = local->Read(buffer, count, &read);
    position += read;
    if (actual) *actual = read;
    return status;
  }
  HRESULT STDMETHODCALLTYPE Write(const void *, ULONG, ULONG *) override { return STG_E_ACCESSDENIED; }
  HRESULT STDMETHODCALLTYPE Seek(LARGE_INTEGER move, DWORD origin, ULARGE_INTEGER *newPosition) override {
    LONGLONG base = 0;
    if (origin == STREAM_SEEK_CUR) base = position;
    else if (origin == STREAM_SEEK_END) base = state->entries[index].bytes;
    else if (origin != STREAM_SEEK_SET) return STG_E_INVALIDFUNCTION;
    if (move.QuadPart < -base || move.QuadPart > INT64_MAX - base) return STG_E_INVALIDFUNCTION;
    const auto next = static_cast<uint64_t>(base + move.QuadPart);
    if (local) {
      LARGE_INTEGER offset{};
      offset.QuadPart = next;
      const HRESULT result = local->Seek(offset, STREAM_SEEK_SET, nullptr);
      if (FAILED(result)) return result;
    }
    position = next;
    if (newPosition) newPosition->QuadPart = position;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE SetSize(ULARGE_INTEGER) override { return STG_E_ACCESSDENIED; }
  HRESULT STDMETHODCALLTYPE CopyTo(IStream *target, ULARGE_INTEGER size, ULARGE_INTEGER *read,
                                    ULARGE_INTEGER *written) override {
    if (!size.QuadPart || position >= state->entries[index].bytes) {
      if (read) read->QuadPart = 0;
      if (written) written->QuadPart = 0;
      return size.QuadPart ? S_FALSE : S_OK;
    }
    const HRESULT result = ensureLocal();
    if (FAILED(result)) return result;
    ULARGE_INTEGER count{};
    const HRESULT status = local->CopyTo(target, size, &count, written);
    position += count.QuadPart;
    if (read) *read = count;
    return status;
  }
  HRESULT STDMETHODCALLTYPE Commit(DWORD) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE Revert() override { return STG_E_INVALIDFUNCTION; }
  HRESULT STDMETHODCALLTYPE LockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return STG_E_INVALIDFUNCTION; }
  HRESULT STDMETHODCALLTYPE UnlockRegion(ULARGE_INTEGER, ULARGE_INTEGER, DWORD) override { return STG_E_INVALIDFUNCTION; }
  HRESULT STDMETHODCALLTYPE Stat(STATSTG *stat, DWORD flags) override {
    if (!stat) return STG_E_INVALIDPOINTER;
    *stat = {};
    const auto &entry = state->entries[index];
    stat->type = STGTY_STREAM;
    stat->cbSize.QuadPart = entry.bytes;
    stat->grfMode = STGM_READ;
    if (!(flags & STATFLAG_NONAME)) {
      const auto size = (entry.name.size() + 1) * sizeof(wchar_t);
      stat->pwcsName = static_cast<LPWSTR>(CoTaskMemAlloc(size));
      if (!stat->pwcsName) return E_OUTOFMEMORY;
      std::memcpy(stat->pwcsName, entry.name.c_str(), size);
    }
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE Clone(IStream **stream) override {
    if (!stream) return STG_E_INVALIDPOINTER;
    auto *clone = new RemoteStream(state, index);
    clone->position = position;
    *stream = clone;
    return S_OK;
  }
};

class DragObject final : public IDataObject, public AsyncCapability {
  std::atomic<ULONG> refs{1};
  std::shared_ptr<DragState> state;
  BOOL async = TRUE;
  BOOL running = FALSE;
  std::map<CLIPFORMAT, std::vector<BYTE>> properties;

  LONG contentIndex(LONG index) const {
    if (index != -1) return index;
    LONG found = -1;
    for (size_t i = 0; i < state->entries.size(); ++i) {
      if (state->entries[i].directory) continue;
      if (found != -1) return -1;
      found = static_cast<LONG>(i);
    }
    return found;
  }

  HRESULT renderGlobal(STGMEDIUM *medium, const void *bytes, size_t size) {
    auto memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, size ? size : 1);
    if (!memory) return E_OUTOFMEMORY;
    auto *buffer = GlobalLock(memory);
    if (!buffer) { GlobalFree(memory); return E_OUTOFMEMORY; }
    if (size) std::memcpy(buffer, bytes, size);
    GlobalUnlock(memory);
    medium->tymed = TYMED_HGLOBAL;
    medium->hGlobal = memory;
    return S_OK;
  }

  HRESULT renderGlobalFile(STGMEDIUM *medium, size_t index) {
    if (!state->dropped) return E_PENDING;
    const auto size = state->entries[index].bytes;
    if (size > maxGlobalFile) return DV_E_TYMED;
    if (!size) return renderGlobal(medium, nullptr, 0);
    IStream *stream = nullptr;
    HRESULT status = state->openFile(index, &stream);
    if (FAILED(status)) return status;
    std::vector<BYTE> bytes(static_cast<size_t>(size));
    ULONG received = 0;
    status = stream->Read(bytes.data(), static_cast<ULONG>(size), &received);
    stream->Release();
    if (FAILED(status) || received != size) {
      state->failed = true;
      return STG_E_READFAULT;
    }
    return renderGlobal(medium, bytes.data(), bytes.size());
  }

  HRESULT renderDescriptors(STGMEDIUM *medium) {
    if (!state->loadManifest()) return STG_E_READFAULT;
    const auto count = state->entries.size();
    auto memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT,
                              offsetof(FILEGROUPDESCRIPTORW, fgd) + count * sizeof(FILEDESCRIPTORW));
    if (!memory) return E_OUTOFMEMORY;
    auto *group = static_cast<FILEGROUPDESCRIPTORW *>(GlobalLock(memory));
    if (!group) { GlobalFree(memory); return E_OUTOFMEMORY; }
    group->cItems = static_cast<UINT>(count);
    for (size_t i = 0; i < count; ++i) {
      const auto &item = state->entries[i];
      auto &descriptor = group->fgd[i];
      descriptor.dwFlags = FD_ATTRIBUTES | FD_UNICODE;
      descriptor.dwFileAttributes = item.directory ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL;
      if (!item.directory) {
        descriptor.dwFlags |= FD_FILESIZE | FD_PROGRESSUI;
        descriptor.nFileSizeHigh = static_cast<DWORD>(item.bytes >> 32);
        descriptor.nFileSizeLow = static_cast<DWORD>(item.bytes);
      }
      std::memcpy(descriptor.cFileName, item.name.c_str(), (item.name.size() + 1) * sizeof(wchar_t));
    }
    GlobalUnlock(memory);
    medium->tymed = TYMED_HGLOBAL;
    medium->hGlobal = memory;
    return S_OK;
  }

public:
  explicit DragObject(std::shared_ptr<DragState> state) : state(std::move(state)) {}
  bool inOperation() const { return running; }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void **object) override {
    *object = nullptr;
    if (iid == IID_IUnknown || iid == IID_IDataObject) *object = static_cast<IDataObject *>(this);
    else if (iid == asyncCapabilityId) *object = static_cast<AsyncCapability *>(this);
    else return E_NOINTERFACE;
    AddRef();
    return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG remaining = --refs;
    if (!remaining) delete this;
    return remaining;
  }
  HRESULT STDMETHODCALLTYPE GetData(FORMATETC *format, STGMEDIUM *medium) override {
    *medium = {};
    const HRESULT accepted = QueryGetData(format);
    if (FAILED(accepted)) return accepted;
    if (format->cfFormat == CF_UNICODETEXT)
      return renderGlobal(medium, state->relayText.c_str(), (state->relayText.size() + 1) * sizeof(wchar_t));
    if (format->cfFormat == rendererTaint || format->cfFormat == ignoreFileContents)
      return renderGlobal(medium, nullptr, 0);
    if (format->cfFormat == descriptors) return renderDescriptors(medium);
    if (format->cfFormat == preferredEffect || format->cfFormat == inDragLoop) {
      const DWORD value = format->cfFormat == preferredEffect ? DROPEFFECT_COPY : !state->dropped;
      return renderGlobal(medium, &value, sizeof(value));
    }
    if (format->cfFormat != contents) {
      const auto &bytes = properties.at(format->cfFormat);
      return renderGlobal(medium, bytes.data(), bytes.size());
    }
    if (!state->loadManifest()) return STG_E_READFAULT;
    const LONG index = contentIndex(format->lindex);
    if (index < 0 || static_cast<size_t>(index) >= state->entries.size() ||
        state->entries[index].directory) return DV_E_LINDEX;
    if (!(format->tymed & TYMED_ISTREAM)) return renderGlobalFile(medium, static_cast<size_t>(index));
    medium->tymed = TYMED_ISTREAM;
    medium->pstm = new RemoteStream(state, static_cast<size_t>(index));
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetDataHere(FORMATETC *, STGMEDIUM *) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE QueryGetData(FORMATETC *format) override {
    if (format->dwAspect != DVASPECT_CONTENT) return DV_E_DVASPECT;
    if (format->cfFormat == CF_UNICODETEXT || format->cfFormat == rendererTaint ||
        format->cfFormat == ignoreFileContents) {
      if (state->relayText.empty()) return DV_E_FORMATETC;
      return format->tymed & TYMED_HGLOBAL ? S_OK : DV_E_TYMED;
    }
    if (format->cfFormat == descriptors || format->cfFormat == preferredEffect ||
        format->cfFormat == inDragLoop || properties.count(format->cfFormat))
      return format->tymed & TYMED_HGLOBAL ? S_OK : DV_E_TYMED;
    if (format->cfFormat == contents) {
      if (!(format->tymed & (TYMED_ISTREAM | TYMED_HGLOBAL))) return DV_E_TYMED;
      if (state->manifestLoaded && format->lindex >= 0) {
        const size_t index = static_cast<size_t>(format->lindex);
        if (index >= state->entries.size() || state->entries[index].directory) return DV_E_LINDEX;
        if (!(format->tymed & TYMED_ISTREAM) && state->entries[index].bytes > maxGlobalFile)
          return DV_E_TYMED;
      }
      return S_OK;
    }
    return DV_E_FORMATETC;
  }
  HRESULT STDMETHODCALLTYPE GetCanonicalFormatEtc(FORMATETC *, FORMATETC *out) override {
    out->ptd = nullptr;
    return DATA_S_SAMEFORMATETC;
  }
  HRESULT STDMETHODCALLTYPE SetData(FORMATETC *format, STGMEDIUM *medium, BOOL release) override {
    if (format->dwAspect != DVASPECT_CONTENT) return DV_E_DVASPECT;
    if (medium->tymed != TYMED_HGLOBAL || !(format->tymed & TYMED_HGLOBAL)) return DV_E_TYMED;
    if (format->cfFormat < 0xc000 || format->cfFormat == descriptors || format->cfFormat == contents ||
        format->cfFormat == preferredEffect || format->cfFormat == inDragLoop ||
        format->cfFormat == rendererTaint || format->cfFormat == ignoreFileContents) return DV_E_FORMATETC;
    const size_t size = GlobalSize(medium->hGlobal);
    if (!size || size > maxGlobalFile ||
        (properties.size() >= 16 && !properties.count(format->cfFormat))) return E_INVALIDARG;
    const auto *bytes = static_cast<const BYTE *>(GlobalLock(medium->hGlobal));
    if (!bytes) return E_INVALIDARG;
    properties[format->cfFormat].assign(bytes, bytes + size);
    GlobalUnlock(medium->hGlobal);
    if (release) ReleaseStgMedium(medium);
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE EnumFormatEtc(DWORD direction, IEnumFORMATETC **result) override {
    if (direction != DATADIR_GET) return E_NOTIMPL;
    std::vector<FORMATETC> formats = {
      { descriptors, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL },
      { preferredEffect, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL },
      { inDragLoop, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL },
    };
    if (!state->relayText.empty()) {
      formats.push_back({ CF_UNICODETEXT, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL });
      formats.push_back({ rendererTaint, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL });
      formats.push_back({ ignoreFileContents, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL });
    }
    // Enumerating supported formats must not scan the remote tree. A target
    // requests the descriptors before retrieving contents at a concrete index.
    if (!state->manifestLoaded)
      formats.push_back({ contents, nullptr, DVASPECT_CONTENT, -1, TYMED_ISTREAM | TYMED_HGLOBAL });
    for (size_t i = 0; i < state->entries.size(); ++i) {
      if (state->entries[i].directory) continue;
      DWORD media = TYMED_ISTREAM;
      if (state->entries[i].bytes <= maxGlobalFile) media |= TYMED_HGLOBAL;
      formats.push_back({ contents, nullptr, DVASPECT_CONTENT, static_cast<LONG>(i), media });
    }
    for (const auto &property : properties)
      formats.push_back({ property.first, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL });
    return SHCreateStdEnumFmtEtc(static_cast<UINT>(formats.size()), formats.data(), result);
  }
  DWORD reportedEffect(DWORD effect) const {
    const auto logical = properties.find(logicalEffect);
    const auto performed = properties.find(performedEffect);
    const auto selected = logical != properties.end() ? logical : performed;
    if (selected != properties.end() && selected->second.size() >= sizeof(DWORD))
      std::memcpy(&effect, selected->second.data(), sizeof(effect));
    return effect;
  }
  HRESULT STDMETHODCALLTYPE DAdvise(FORMATETC *, DWORD, IAdviseSink *, DWORD *) override { return OLE_E_ADVISENOTSUPPORTED; }
  HRESULT STDMETHODCALLTYPE DUnadvise(DWORD) override { return OLE_E_ADVISENOTSUPPORTED; }
  HRESULT STDMETHODCALLTYPE EnumDAdvise(IEnumSTATDATA **) override { return OLE_E_ADVISENOTSUPPORTED; }
  HRESULT STDMETHODCALLTYPE SetAsyncMode(BOOL enabled) override { async = enabled; return S_OK; }
  HRESULT STDMETHODCALLTYPE GetAsyncMode(BOOL *enabled) override { *enabled = async; return S_OK; }
  HRESULT STDMETHODCALLTYPE StartOperation(IBindCtx *) override { running = TRUE; return S_OK; }
  HRESULT STDMETHODCALLTYPE InOperation(BOOL *active) override { *active = running; return S_OK; }
  HRESULT STDMETHODCALLTYPE EndOperation(HRESULT result, IBindCtx *, DWORD effect) override {
    running = FALSE;
    if (FAILED(result) || effect == DROPEFFECT_NONE) state->failed = true;
    return S_OK;
  }
};

class DropSource final : public IDropSource {
  std::atomic<ULONG> refs{1};
  std::shared_ptr<DragState> state;
public:
  explicit DropSource(std::shared_ptr<DragState> state) : state(std::move(state)) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void **object) override {
    *object = nullptr;
    if (iid != IID_IUnknown && iid != IID_IDropSource) return E_NOINTERFACE;
    *object = static_cast<IDropSource *>(this);
    AddRef();
    return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
  ULONG STDMETHODCALLTYPE Release() override {
    const ULONG remaining = --refs;
    if (!remaining) delete this;
    return remaining;
  }
  HRESULT STDMETHODCALLTYPE QueryContinueDrag(BOOL escape, DWORD keys) override {
    if (escape || (keys & MK_RBUTTON)) {
      state->cancelled = true;
      return DRAGDROP_S_CANCEL;
    }
    if (keys & MK_LBUTTON) return S_OK;
    state->dropped = true;
    return DRAGDROP_S_DROP;
  }
  HRESULT STDMETHODCALLTYPE GiveFeedback(DWORD) override { return DRAGDROP_S_USEDEFAULTCURSORS; }
};

void pumpUntilFinished(DragObject *object, DragState &state) {
  while (object->inOperation()) {
    const DWORD waited = MsgWaitForMultipleObjects(0, nullptr, FALSE, 60000, QS_ALLINPUT);
    if (waited == WAIT_TIMEOUT || waited == WAIT_FAILED) {
      state.failed = true;
      break;
    }
    MSG message;
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  }
}

void drag(const std::string &token, const std::wstring &relayText) {
  if (!(GetAsyncKeyState(VK_LBUTTON) & 0x8000)) {
    std::cout << "done\t" << token << "\treleased" << std::endl;
    return;
  }
  auto state = std::make_shared<DragState>();
  state->token = token;
  state->relayText = relayText;
  auto *object = new DragObject(state);
  auto *source = new DropSource(state);
  DWORD effect = DROPEFFECT_NONE;
  const HRESULT result = SHDoDragDrop(nullptr, object, source, DROPEFFECT_COPY, &effect);
  if (result == DRAGDROP_S_DROP) pumpUntilFinished(object, *state);
  effect = object->reportedEffect(effect);
  object->Release();
  source->Release();
  const char *status = state->failed || FAILED(result) ? "failed" :
                       state->cancelled ? "cancelled" :
                       effect & DROPEFFECT_COPY ? "copy" : "rejected";
  std::cout << "done\t" << token << '\t' << status << std::endl;
}

bool checkDataObject() {
  const BYTE expected[] = {0, 255, 10, 13, 128};
  wchar_t file[MAX_PATH];
  const DWORD length = GetFullPathNameW(L"drop-test.bin", MAX_PATH, file, nullptr);
  if (!length || length >= MAX_PATH) return false;
  auto state = std::make_shared<DragState>();
  const std::wstring relayText = L"jayxterm-sftp:test-token";
  state->relayText = relayText;
  // Reading the relay formats must not need a manifest or file download.
  DragObject relayObject(state);
  FORMATETC text{CF_UNICODETEXT, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
  STGMEDIUM textMedium{};
  if (FAILED(relayObject.GetData(&text, &textMedium))) return false;
  const auto *textBytes = static_cast<const wchar_t *>(GlobalLock(textMedium.hGlobal));
  const bool textOk = textBytes && relayText == textBytes;
  if (textBytes) GlobalUnlock(textMedium.hGlobal);
  ReleaseStgMedium(&textMedium);
  if (!textOk || state->manifestLoaded || !state->staged.empty()) return false;
  for (auto marker : {rendererTaint, ignoreFileContents}) {
    FORMATETC format{marker, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
    if (FAILED(relayObject.GetData(&format, &textMedium))) return false;
    ReleaseStgMedium(&textMedium);
  }
  IEnumFORMATETC *pendingFormats = nullptr;
  if (FAILED(relayObject.EnumFormatEtc(DATADIR_GET, &pendingFormats))) return false;
  pendingFormats->Release();
  if (state->manifestLoaded || !state->staged.empty()) return false;
  auto externalState = std::make_shared<DragState>();
  DragObject externalObject(externalState);
  if (externalObject.QueryGetData(&text) != DV_E_FORMATETC) return false;
  state->entries = {{L"sample", true, 0}, {L"sample\\file.bin", false, sizeof(expected)},
                    {L"sample\\large.bin", false, maxGlobalFile + 1}};
  state->manifestLoaded = true;
  state->staged.emplace(1, file);
  DragObject object(state);
  FORMATETC descriptor{descriptors, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
  STGMEDIUM medium{};
  if (FAILED(object.GetData(&descriptor, &medium))) return false;
  const auto *group = static_cast<const FILEGROUPDESCRIPTORW *>(GlobalLock(medium.hGlobal));
  const bool descriptorsOk = group && group->cItems == 3 &&
    (group->fgd[0].dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
    group->fgd[1].nFileSizeLow == sizeof(expected);
  if (group) GlobalUnlock(medium.hGlobal);
  ReleaseStgMedium(&medium);
  if (!descriptorsOk) return false;
  IEnumFORMATETC *listed = nullptr;
  if (FAILED(object.EnumFormatEtc(DATADIR_GET, &listed))) return false;
  FORMATETC format{};
  DWORD smallMedia = 0, largeMedia = 0;
  unsigned relayFormats = 0;
  while (listed->Next(1, &format, nullptr) == S_OK) {
    if (format.cfFormat == contents && format.lindex == 1) smallMedia = format.tymed;
    if (format.cfFormat == contents && format.lindex == 2) largeMedia = format.tymed;
    if ((format.cfFormat == CF_UNICODETEXT || format.cfFormat == rendererTaint ||
         format.cfFormat == ignoreFileContents) && format.tymed == TYMED_HGLOBAL) ++relayFormats;
  }
  listed->Release();
  if (relayFormats != 3 || smallMedia != (TYMED_ISTREAM | TYMED_HGLOBAL) || largeMedia != TYMED_ISTREAM) return false;
  FORMATETC content{contents, nullptr, DVASPECT_CONTENT, 1, TYMED_HGLOBAL};
  if (object.GetData(&content, &medium) != E_PENDING) return false;
  state->dropped = true;
  if (FAILED(object.GetData(&content, &medium))) return false;
  const auto *bytes = static_cast<const BYTE *>(GlobalLock(medium.hGlobal));
  const bool globalOk = bytes && std::memcmp(bytes, expected, sizeof(expected)) == 0;
  if (bytes) GlobalUnlock(medium.hGlobal);
  ReleaseStgMedium(&medium);
  if (!globalOk) return false;
  content.tymed = TYMED_ISTREAM;
  if (FAILED(object.GetData(&content, &medium))) return false;
  BYTE output[sizeof(expected)]{};
  ULONG read = 0;
  const auto result = medium.pstm->Read(output, sizeof(output), &read);
  ReleaseStgMedium(&medium);
  return SUCCEEDED(result) && read == sizeof(expected) &&
    std::memcmp(output, expected, sizeof(expected)) == 0;
}
} // namespace

int main(int argc, char **argv) {
  if (FAILED(OleInitialize(nullptr))) return 1;
  if (argc == 2 && std::strcmp(argv[1], "--self-test") == 0) {
    const bool success = checkDataObject();
    std::cout << (success ? "PASS: Windows Shell drag data formats" : "FAIL: Windows Shell drag data formats") << std::endl;
    OleUninitialize();
    return success ? 0 : 1;
  }
  std::cout << "ready" << std::endl;
  for (std::string line; std::getline(std::cin, line);) {
    const auto command = fields(line);
    if ((command.size() == 2 || command.size() == 3) && command[0] == "drag")
      drag(command[1], command.size() == 3 ? wide(command[2]) : std::wstring());
  }
  OleUninitialize();
  return 0;
}
