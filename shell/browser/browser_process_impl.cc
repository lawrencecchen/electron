// Copyright (c) 2012 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#include "shell/browser/browser_process_impl.h"

#include <memory>

#include <utility>

#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/notimplemented.h"
#include "base/path_service.h"
#include "base/time/default_clock.h"
#include "base/time/default_tick_clock.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/hid/hid_system_tray_icon.h"
#include "chrome/browser/usb/usb_system_tray_icon.h"
#include "chrome/common/chrome_switches.h"
#include "components/os_crypt/async/browser/key_provider.h"
#include "components/os_crypt/async/browser/os_crypt_async.h"
#include "components/os_crypt/sync/os_crypt.h"
#include "components/prefs/in_memory_pref_store.h"
#include "components/prefs/json_pref_store.h"
#include "components/prefs/pref_registry.h"
#include "components/prefs/pref_registry_simple.h"
#include "components/prefs/pref_service.h"
#include "components/prefs/pref_service_factory.h"
#include "components/proxy_config/pref_proxy_config_tracker_impl.h"
#include "components/proxy_config/proxy_config_dictionary.h"
#include "components/proxy_config/proxy_config_pref_names.h"
#include "components/supervised_user/core/browser/device_parental_controls_noop_impl.h"  // nogncheck
#include "content/public/browser/child_process_security_policy.h"
#include "content/public/browser/network_quality_observer_factory.h"
#include "content/public/browser/network_service_instance.h"
#include "content/public/common/content_switches.h"
#include "extensions/common/constants.h"
#include "net/proxy_resolution/proxy_config.h"
#include "net/proxy_resolution/proxy_config_service.h"
#include "net/proxy_resolution/proxy_config_with_annotation.h"
#include "services/device/public/cpp/geolocation/geolocation_system_permission_manager.h"
#include "services/network/public/cpp/network_switches.h"
#include "shell/browser/metrics/electron_metrics_service_client.h"
#include "shell/browser/net/resolve_proxy_helper.h"
#include "shell/common/electron_constants.h"
#include "shell/common/electron_paths.h"
#include "shell/common/options_switches.h"
#include "shell/common/thread_restrictions.h"

#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
#include "chrome/browser/enterprise/browser_management/management_service_factory.h"
#include "chrome/browser/global_features.h"
#include "chrome/browser/policy/chrome_browser_policy_connector.h"
#include "chrome/browser/prefs/browser_prefs.h"
#include "chrome/browser/prefs/chrome_pref_service_factory.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/common/pref_names.h"
#include "chrome/installer/util/google_update_settings.h"
#include "components/language/core/browser/pref_names.h"
#include "components/metrics/metrics_pref_names.h"
#include "components/network_time/network_time_tracker.h"
#include "components/policy/core/browser/browser_policy_connector.h"
#endif

#if BUILDFLAG(ENABLE_PRINTING)
#include "chrome/browser/printing/print_job_manager.h"
#endif

#if BUILDFLAG(IS_LINUX)
#include "build/config/linux/dbus/buildflags.h"
#include "chrome/browser/browser_features.h"
#include "components/os_crypt/async/browser/freedesktop_secret_key_provider.h"
#include "components/os_crypt/async/browser/secret_portal_key_provider.h"
#include "components/password_manager/core/browser/password_manager_switches.h"  // nogncheck
#include "shell/common/application_info.h"

#endif

#if BUILDFLAG(IS_WIN)
#include "components/os_crypt/async/browser/dpapi_key_provider.h"
#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
#include "chrome/browser/win/isolated_browser_support.h"
#endif
#endif

#if BUILDFLAG(IS_MAC)
#include "chrome/common/chrome_features.h"
#include "components/os_crypt/async/browser/keychain_key_provider.h"
#endif

#if BUILDFLAG(IS_POSIX) && !BUILDFLAG(IS_MAC)
#include "components/os_crypt/async/browser/posix_key_provider.h"
#endif

BrowserProcessImpl::BrowserProcessImpl()
#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
    : chrome_browser_policy_connector_(
          std::make_unique<policy::ChromeBrowserPolicyConnector>()),
      chrome_global_features_(GlobalFeatures::CreateGlobalFeatures())
#endif
{
  CHECK(!g_browser_process);
  g_browser_process = this;

#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
  CHECK(chrome_browser_policy_connector_);
  CHECK(chrome_global_features_);
  chrome_global_features_->Init();
  chrome_network_time_tracker_ =
      std::make_unique<network_time::NetworkTimeTracker>(
          std::make_unique<base::DefaultClock>(),
          std::make_unique<base::DefaultTickClock>(),
          /*pref_service=*/nullptr,
          /*url_loader_factory=*/nullptr,
          /*fetch_behavior=*/std::nullopt);
  CHECK(!chrome_network_time_tracker_->is_initialized());
#endif
}

BrowserProcessImpl::~BrowserProcessImpl() {
  g_browser_process = nullptr;
}

// static
void BrowserProcessImpl::ApplyProxyModeFromCommandLine(
    ValueMapPrefStore* pref_store) {
  if (!pref_store)
    return;

  auto* command_line = base::CommandLine::ForCurrentProcess();

  if (command_line->HasSwitch(switches::kNoProxyServer)) {
    pref_store->SetValue(proxy_config::prefs::kProxy,
                         base::Value(ProxyConfigDictionary::CreateDirect()),
                         WriteablePrefStore::DEFAULT_PREF_WRITE_FLAGS);
  } else if (command_line->HasSwitch(switches::kProxyPacUrl)) {
    std::string pac_script_url =
        command_line->GetSwitchValueASCII(switches::kProxyPacUrl);
    pref_store->SetValue(proxy_config::prefs::kProxy,
                         base::Value(ProxyConfigDictionary::CreatePacScript(
                             pac_script_url, false /* pac_mandatory */)),
                         WriteablePrefStore::DEFAULT_PREF_WRITE_FLAGS);
  } else if (command_line->HasSwitch(switches::kProxyAutoDetect)) {
    pref_store->SetValue(proxy_config::prefs::kProxy,
                         base::Value(ProxyConfigDictionary::CreateAutoDetect()),
                         WriteablePrefStore::DEFAULT_PREF_WRITE_FLAGS);
  } else if (command_line->HasSwitch(switches::kProxyServer)) {
    std::string proxy_server =
        command_line->GetSwitchValueASCII(switches::kProxyServer);
    std::string bypass_list =
        command_line->GetSwitchValueASCII(switches::kProxyBypassList);
    pref_store->SetValue(proxy_config::prefs::kProxy,
                         base::Value(ProxyConfigDictionary::CreateFixedServers(
                             proxy_server, bypass_list)),
                         WriteablePrefStore::DEFAULT_PREF_WRITE_FLAGS);
  }
}

#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
// static
void BrowserProcessImpl::RegisterPrefs(PrefRegistrySimple* registry) {
  // Keep this list aligned with Chromium 152 BrowserProcessImpl::RegisterPrefs.
  // RegisterLocalState() calls this symbol while building the real Chrome Local
  // State used by ProfileImpl.
  registry->RegisterBooleanPref(prefs::kDefaultBrowserSettingEnabled, false);
  registry->RegisterBooleanPref(prefs::kAllowCrossOriginAuthPrompt, false);

#if BUILDFLAG(IS_WIN)
  registry->RegisterBooleanPref(prefs::kProcessIsolationEnabled,
                                chrome::IsIsolationEnabled());
#endif

  registry->RegisterStringPref(language::prefs::kApplicationLocale,
                               std::string());
  registry->RegisterBooleanPref(metrics::prefs::kMetricsReportingEnabled,
                                GoogleUpdateSettings::GetCollectStatsConsent());
  registry->RegisterBooleanPref(prefs::kDevToolsRemoteDebuggingAllowed, true);
  registry->RegisterBooleanPref(prefs::kDevToolsRemoteDebuggingEnabled, false);

#if BUILDFLAG(IS_LINUX) && BUILDFLAG(USE_DBUS)
  os_crypt_async::SecretPortalKeyProvider::RegisterLocalPrefs(registry);
#endif
}
#endif

BuildState* BrowserProcessImpl::GetBuildState() {
  NOTIMPLEMENTED();
  return nullptr;
}

GlobalFeatures* BrowserProcessImpl::GetFeatures() {
#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
  return chrome_global_features_.get();
#else
  NOTIMPLEMENTED();
  return nullptr;
#endif
}

ui::UnownedUserDataHost& BrowserProcessImpl::GetUnownedUserDataHost() {
  NOTIMPLEMENTED();
  static base::NoDestructor<ui::UnownedUserDataHost> instance;
  return *instance;
}

const ui::UnownedUserDataHost& BrowserProcessImpl::GetUnownedUserDataHost()
    const {
  NOTIMPLEMENTED();
  static base::NoDestructor<ui::UnownedUserDataHost> instance;
  return *instance;
}

void BrowserProcessImpl::PostEarlyInitialization() {
  auto pref_registry = base::MakeRefCounted<PrefRegistrySimple>();

#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
  // ProfileImpl and Chrome's keyed services read a broad Local State contract.
  // Use Chromium's generated registration list instead of adding preferences
  // reactively as individual services crash.
  RegisterLocalState(pref_registry.get());
#else
  PrefProxyConfigTrackerImpl::RegisterPrefs(pref_registry.get());
  electron::ElectronMetricsServiceClient::RegisterMetricsPrefs(
      pref_registry.get());

#if BUILDFLAG(IS_WIN)
  OSCrypt::RegisterLocalPrefs(pref_registry.get());
#endif

#if BUILDFLAG(IS_LINUX)
  os_crypt_async::SecretPortalKeyProvider::RegisterLocalPrefs(
      pref_registry.get());
#endif
#endif

  pref_registry->RegisterDictionaryPref(electron::kWindowStates);

  in_memory_pref_store_ = base::MakeRefCounted<ValueMapPrefStore>();
  ApplyProxyModeFromCommandLine(in_memory_pref_store());

#if !BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
  PrefServiceFactory prefs_factory;
  prefs_factory.set_command_line_prefs(in_memory_pref_store());
#endif

  base::FilePath prefs_path;
#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
  const base::FilePath chrome_profile_path =
      base::CommandLine::ForCurrentProcess()->GetSwitchValuePath(
          electron::switches::kChromeProfileSmoke);
  CHECK(!chrome_profile_path.empty() && chrome_profile_path.IsAbsolute())
      << "--chrome-profile-smoke requires an absolute profile path";
  chrome_profile_user_data_dir_ = chrome_profile_path.DirName();
  prefs_path = chrome_profile_user_data_dir_;
#else
  CHECK(base::PathService::Get(electron::DIR_SESSION_DATA, &prefs_path));
#endif
  if (!base::DirectoryExists(prefs_path))
    base::CreateDirectory(prefs_path);
  prefs_path = prefs_path.Append(FILE_PATH_LITERAL("Local State"));

  electron::ScopedAllowBlockingForElectron allow_blocking;
  scoped_refptr<JsonPrefStore> user_pref_store =
      base::MakeRefCounted<JsonPrefStore>(prefs_path);
  const auto pref_read_error = user_pref_store->ReadPrefs();

#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
  CHECK(chrome_browser_policy_connector_);
  if (pref_read_error == JsonPrefStore::PREF_READ_ERROR_NONE) {
    policy::ManagementServiceFactory::GetForPlatform()->UsePrefStoreAsCache(
        user_pref_store);
  }
  local_state_ = chrome_prefs::CreateLocalState(
      prefs_path, user_pref_store,
      chrome_browser_policy_connector_->GetPolicyService(),
      std::move(pref_registry), chrome_browser_policy_connector_.get());
  chrome_browser_policy_connector_->MaybeApplyLocalTestPolicies(
      local_state_.get());
#else
  static_cast<void>(pref_read_error);
  prefs_factory.set_user_prefs(user_pref_store);
  DCHECK(user_pref_store->IsInitializationComplete());

  local_state_ = prefs_factory.Create(std::move(pref_registry));
#endif
}

void BrowserProcessImpl::PreCreateThreads() {
  // chrome-extension:// URLs are safe to request anywhere, but may only
  // commit (including in iframes) in extension processes.
  content::ChildProcessSecurityPolicy::GetInstance()
      ->RegisterWebSafeIsolatedScheme(extensions::kExtensionScheme);
  // Must be created before the IOThread.
  // Once IOThread class is no longer needed,
  // this can be created on first use.
#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
  if (!SystemNetworkContextManager::HasInstance())
    SystemNetworkContextManager::CreateInstance(local_state_.get());
#else
  if (!SystemNetworkContextManager::GetInstance())
    SystemNetworkContextManager::CreateInstance(local_state_.get());
#endif

  // Needs to be called here as per
  // https://source.chromium.org/chromium/chromium/src/+/main:chrome/browser/chrome_browser_main.cc;l=1385-1389;drc=c3bda003554dad21313fb24b7a4f3e1aae6102d9.
  CreateMetricsServiceClient();
}

void BrowserProcessImpl::PreMainMessageLoopRun() {
#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
  // Chrome's network manager may request OSCrypt while the NetworkService is
  // first created. Make the provider available before any call that can start
  // that service.
  CreateOSCryptAsync();
  CreateNetworkQualityObserver();
#else
  CreateNetworkQualityObserver();
  CreateOSCryptAsync();
#endif

#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
  CHECK(chrome_network_time_tracker_);
  CHECK(!chrome_network_time_tracker_->is_initialized());
  chrome_network_time_tracker_->Initialize(
      local_state(),
      system_network_context_manager()->GetSharedURLLoaderFactory());

  CHECK(chrome_browser_policy_connector_);
  chrome_browser_policy_connector_->Init(
      local_state(),
      system_network_context_manager()->GetSharedURLLoaderFactory());
  chrome_browser_policy_connector_->InitCloudManagementController(
      local_state(),
      system_network_context_manager()->GetSharedURLLoaderFactory());
  CHECK(chrome_browser_policy_connector_->GetPolicyService());
  chrome_policy_initialized_ = true;
#endif
}

void BrowserProcessImpl::OnResourceBundleCreated() {
#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
  CHECK(chrome_browser_policy_connector_);
  chrome_browser_policy_connector_->OnResourceBundleCreated();
#endif
}

void BrowserProcessImpl::PostMainMessageLoopRun() {
  is_shutting_down_ = true;

#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
  CHECK(chrome_global_features_);
  chrome_global_features_->PostMainMessageLoopRun();

  // Profiles own BrowserContext keyed services and storage partitions. Tear
  // them down while the UI thread, local state, and network service still
  // exist, matching Chrome's BrowserProcessImpl ordering.
  chrome_profile_manager_.reset();
  LOG(INFO) << "Chrome profile smoke destroyed ProfileManager";

  if (chrome_policy_initialized_) {
    chrome_browser_policy_connector_->Shutdown();
    chrome_policy_initialized_ = false;
  }
#endif

  if (local_state_)
    local_state_->CommitPendingWrite();

  // This expects to be destroyed before the task scheduler is torn down.
  SystemNetworkContextManager::DeleteInstance();
}

void BrowserProcessImpl::PostDestroyThreads() {
#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
  DCHECK(!chrome_profile_manager_);
  CHECK(chrome_global_features_);
  chrome_global_features_->PostDestroyThreads();
  chrome_global_features_.reset();
#endif
}

bool BrowserProcessImpl::IsShuttingDown() {
  return is_shutting_down_;
}

metrics_services_manager::MetricsServicesManager*
BrowserProcessImpl::GetMetricsServicesManager() {
  return nullptr;
}

metrics::MetricsService* BrowserProcessImpl::metrics_service() {
  return metrics_service_client_ ? metrics_service_client_->GetMetricsService()
                                 : nullptr;
}

ProfileManager* BrowserProcessImpl::profile_manager() {
#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
  return chrome_profile_manager_.get();
#else
  return nullptr;
#endif
}

#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
void BrowserProcessImpl::InitializeChromeProfileManager(
    const base::FilePath& chrome_profile_path) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  CHECK(!chrome_profile_path.empty());
  CHECK(chrome_profile_path.IsAbsolute())
      << "--chrome-profile-smoke requires an absolute profile path";
  CHECK(!chrome_profile_manager_)
      << "Chrome ProfileManager must have exactly one BrowserProcess owner";

  // Chromium 152's ProfileManager contains a BrowserCollectionObserver whose
  // constructor immediately observes GlobalBrowserCollection::GetInstance().
  // Keep this invariant ahead of the constructor so a broken GN extraction or
  // lifecycle regression cannot turn into a null dereference.
  GlobalFeatures* features = GetFeatures();
  CHECK(features && features->global_browser_collection())
      << "Chrome profile runtime requires BrowserProcessImpl-owned, "
         "initialized "
         "Chromium GlobalFeatures and GlobalBrowserCollection before "
         "constructing ProfileManager.";

  CHECK_EQ(chrome_profile_path.DirName(), chrome_profile_user_data_dir_)
      << "Chrome ProfileManager and Local State must share one user data root";
  chrome_profile_manager_ =
      std::make_unique<ProfileManager>(chrome_profile_user_data_dir_);
  CHECK_EQ(chrome_profile_manager_->user_data_dir(),
           chrome_profile_user_data_dir_);
}

Profile* BrowserProcessImpl::CreateChromeProfileForSmoke(
    const base::FilePath& chrome_profile_path) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  CHECK(chrome_profile_manager_);
  CHECK_EQ(chrome_profile_path.DirName(), chrome_profile_user_data_dir_);
  CHECK(local_state_);
  CHECK(os_crypt_async_);
  CHECK(SystemNetworkContextManager::GetInstance());
  CHECK(!GetApplicationLocale().empty());

  // ProfileImpl::LoadPrefsForNormalStartup() unconditionally dereferences the
  // ChromeBrowserPolicyConnector to build its schema registry. Never replace
  // this with a null policy service or a partial Profile adapter.
  auto* connector = browser_policy_connector();
  CHECK(chrome_policy_initialized_ && connector &&
        connector->GetPolicyService())
      << "Chrome ProfileImpl creation requires an initialized "
         "ChromeBrowserPolicyConnector. It must be created before Local State "
         "and initialized with Local State plus the system URL loader before "
         "the smoke probe may call ProfileManager::GetProfile().";

  Profile* profile = chrome_profile_manager_->GetProfile(chrome_profile_path);
  CHECK(profile) << "Chromium failed to create the smoke ProfileImpl at "
                 << chrome_profile_path;
  CHECK_EQ(profile->GetPath(), chrome_profile_path);
  return profile;
}
#endif

PrefService* BrowserProcessImpl::local_state() {
  DCHECK(local_state_.get());
  return local_state_.get();
}

signin::ActivePrimaryAccountsMetricsRecorder*
BrowserProcessImpl::active_primary_accounts_metrics_recorder() {
  return nullptr;
}

scoped_refptr<network::SharedURLLoaderFactory>
BrowserProcessImpl::shared_url_loader_factory() {
  return system_network_context_manager()->GetSharedURLLoaderFactory();
}

variations::VariationsService* BrowserProcessImpl::variations_service() {
  return nullptr;
}

BrowserProcessPlatformPart* BrowserProcessImpl::platform_part() {
  return nullptr;
}

NotificationUIManager* BrowserProcessImpl::notification_ui_manager() {
  return nullptr;
}

NotificationPlatformBridge* BrowserProcessImpl::notification_platform_bridge() {
  return nullptr;
}

SystemNetworkContextManager*
BrowserProcessImpl::system_network_context_manager() {
  DCHECK(SystemNetworkContextManager::GetInstance());
  return SystemNetworkContextManager::GetInstance();
}

network::NetworkQualityTracker* BrowserProcessImpl::network_quality_tracker() {
  return nullptr;
}

embedder_support::OriginTrialsSettingsStorage*
BrowserProcessImpl::GetOriginTrialsSettingsStorage() {
  return &origin_trials_settings_storage_;
}

policy::ChromeBrowserPolicyConnector*
BrowserProcessImpl::browser_policy_connector() {
#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
  return chrome_browser_policy_connector_.get();
#else
  return nullptr;
#endif
}

policy::PolicyService* BrowserProcessImpl::policy_service() {
#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
  return chrome_browser_policy_connector_->GetPolicyService();
#else
  return nullptr;
#endif
}

IconManager* BrowserProcessImpl::icon_manager() {
  return nullptr;
}

GpuModeManager* BrowserProcessImpl::gpu_mode_manager() {
  return nullptr;
}

printing::PrintPreviewDialogController*
BrowserProcessImpl::print_preview_dialog_controller() {
  return nullptr;
}

printing::BackgroundPrintingManager*
BrowserProcessImpl::background_printing_manager() {
  return nullptr;
}

supervised_user::DeviceParentalControls&
BrowserProcessImpl::device_parental_controls() {
  if (!device_parental_controls_)
    device_parental_controls_ =
        std::make_unique<supervised_user::DeviceParentalControlsNoOpImpl>();
  return *device_parental_controls_;
}

activity_reporter::ActivityReporter* BrowserProcessImpl::activity_reporter() {
  return nullptr;
}

IntranetRedirectDetector* BrowserProcessImpl::intranet_redirect_detector() {
  return nullptr;
}

DownloadStatusUpdater* BrowserProcessImpl::download_status_updater() {
  return nullptr;
}

DownloadRequestLimiter* BrowserProcessImpl::download_request_limiter() {
  return nullptr;
}

BackgroundModeManager* BrowserProcessImpl::background_mode_manager() {
  return nullptr;
}

StatusTray* BrowserProcessImpl::status_tray() {
  return nullptr;
}

safe_browsing::SafeBrowsingService*
BrowserProcessImpl::safe_browsing_service() {
  return nullptr;
}

subresource_filter::RulesetService*
BrowserProcessImpl::subresource_filter_ruleset_service() {
  return nullptr;
}

component_updater::ComponentUpdateService*
BrowserProcessImpl::component_updater() {
  return nullptr;
}

WebRtcLogUploader* BrowserProcessImpl::webrtc_log_uploader() {
  return nullptr;
}

network_time::NetworkTimeTracker* BrowserProcessImpl::network_time_tracker() {
#if BUILDFLAG(ENABLE_FULL_CHROME_EXTENSIONS)
  return chrome_network_time_tracker_.get();
#else
  return nullptr;
#endif
}

gcm::GCMDriver* BrowserProcessImpl::gcm_driver() {
  return nullptr;
}

resource_coordinator::ResourceCoordinatorParts*
BrowserProcessImpl::resource_coordinator_parts() {
  return nullptr;
}

resource_coordinator::TabManager* BrowserProcessImpl::GetTabManager() {
  return nullptr;
}

SerialPolicyAllowedPorts* BrowserProcessImpl::serial_policy_allowed_ports() {
  return nullptr;
}

HidSystemTrayIcon* BrowserProcessImpl::hid_system_tray_icon() {
  return nullptr;
}

void BrowserProcessImpl::set_hid_system_tray_icon_for_test(
    std::unique_ptr<HidSystemTrayIcon> icon) {}

UsbSystemTrayIcon* BrowserProcessImpl::usb_system_tray_icon() {
  return nullptr;
}

void BrowserProcessImpl::set_usb_system_tray_icon_for_test(
    std::unique_ptr<UsbSystemTrayIcon> icon) {}

os_crypt_async::OSCryptAsync* BrowserProcessImpl::os_crypt_async() {
  return os_crypt_async_.get();
}

void BrowserProcessImpl::set_additional_os_crypt_async_provider_for_test(
    size_t precedence,
    std::unique_ptr<os_crypt_async::KeyProvider> provider) {}

void BrowserProcessImpl::SetSystemLocale(const std::string& locale) {
  system_locale_ = locale;
}

const std::string& BrowserProcessImpl::GetSystemLocale() const {
  return system_locale_;
}

electron::ResolveProxyHelper* BrowserProcessImpl::GetResolveProxyHelper() {
  if (!resolve_proxy_helper_) {
    resolve_proxy_helper_ = base::MakeRefCounted<electron::ResolveProxyHelper>(
        nullptr /* browser_context */);
  }
  return resolve_proxy_helper_.get();
}

#if BUILDFLAG(IS_LINUX)
void BrowserProcessImpl::SetLinuxStorageBackend(
    os_crypt::SelectedLinuxBackend selected_backend) {
  switch (selected_backend) {
    case os_crypt::SelectedLinuxBackend::BASIC_TEXT:
      selected_linux_storage_backend_ = "basic_text";
      break;
    case os_crypt::SelectedLinuxBackend::GNOME_LIBSECRET:
      selected_linux_storage_backend_ = "gnome_libsecret";
      break;
    case os_crypt::SelectedLinuxBackend::KWALLET:
      selected_linux_storage_backend_ = "kwallet";
      break;
    case os_crypt::SelectedLinuxBackend::KWALLET5:
      selected_linux_storage_backend_ = "kwallet5";
      break;
    case os_crypt::SelectedLinuxBackend::KWALLET6:
      selected_linux_storage_backend_ = "kwallet6";
      break;
    case os_crypt::SelectedLinuxBackend::DEFER:
      NOTREACHED();
  }
}
#endif  // BUILDFLAG(IS_LINUX)

void BrowserProcessImpl::SetApplicationLocale(const std::string& locale) {
  locale_ = locale;
}

const std::string& BrowserProcessImpl::GetApplicationLocale() {
  return locale_;
}

printing::PrintJobManager* BrowserProcessImpl::print_job_manager() {
#if BUILDFLAG(ENABLE_PRINTING)
  if (!print_job_manager_)
    print_job_manager_ = std::make_unique<printing::PrintJobManager>();
  return print_job_manager_.get();
#else
  return nullptr;
#endif
}

StartupData* BrowserProcessImpl::startup_data() {
  return nullptr;
}

network::NetworkQualityTracker* BrowserProcessImpl::GetNetworkQualityTracker() {
  if (!network_quality_tracker_) {
    network_quality_tracker_ = std::make_unique<network::NetworkQualityTracker>(
        base::BindRepeating(&content::GetNetworkService));
  }
  return network_quality_tracker_.get();
}

void BrowserProcessImpl::CreateNetworkQualityObserver() {
  DCHECK(!network_quality_observer_);
  network_quality_observer_ =
      content::CreateNetworkQualityObserver(GetNetworkQualityTracker());
  DCHECK(network_quality_observer_);
}

void BrowserProcessImpl::CreateOSCryptAsync() {
  std::vector<std::pair<size_t, std::unique_ptr<os_crypt_async::KeyProvider>>>
      providers;

#if BUILDFLAG(IS_WIN)
  // The DPAPI key provider requires OSCrypt::Init to have already been called
  // to initialize the key storage. This happens in
  // BrowserMainPartsWin::PreCreateMainMessageLoop.
  providers.emplace_back(
      /*precedence=*/10u,
      std::make_unique<os_crypt_async::DPAPIKeyProvider>(local_state()));
#endif  // BUILDFLAG(IS_WIN)

#if BUILDFLAG(IS_LINUX)
  base::CommandLine* cmd_line = base::CommandLine::ForCurrentProcess();
  const auto password_store =
      cmd_line->GetSwitchValueASCII(password_manager::kPasswordStore);

  if (base::FeatureList::IsEnabled(features::kDbusSecretPortal)) {
    // Use a higher priority than the FreedesktopSecretKeyProvider.
    providers.emplace_back(
        /*precedence=*/15u,
        std::make_unique<os_crypt_async::SecretPortalKeyProvider>(
            local_state(),
            base::FeatureList::IsEnabled(
                features::kSecretPortalKeyProviderUseForEncryption)));
  }

  auto freedesktop_config =
      os_crypt_async::FreedesktopSecretKeyProvider::GetDefaultConfig();

  const std::string app_name = electron::GetApplicationName();
  freedesktop_config.app_name = app_name;
  freedesktop_config.kwallet_folder = app_name + " Keys";
  freedesktop_config.key_name = app_name + " Safe Storage";

  providers.emplace_back(
      /*precedence=*/10u,
      std::make_unique<os_crypt_async::FreedesktopSecretKeyProvider>(
          password_store, electron::GetApplicationName(), freedesktop_config,
          nullptr));
#endif  // BUILDFLAG(IS_LINUX)

#if BUILDFLAG(IS_POSIX) && !BUILDFLAG(IS_MAC)
  // On other POSIX systems, this is the only key provider. On Linux, it is used
  // as a fallback.
  providers.emplace_back(
      /*precedence=*/5u, std::make_unique<os_crypt_async::PosixKeyProvider>());
#endif  // BUILDFLAG(IS_POSIX) && !BUILDFLAG(IS_MAC)

#if BUILDFLAG(IS_MAC)
  if (base::FeatureList::IsEnabled(features::kUseKeychainKeyProvider)) {
    providers.emplace_back(
        /*precedence=*/10u,
        std::make_unique<os_crypt_async::KeychainKeyProvider>());
  }
#endif  // BUILDFLAG(IS_MAC)

  os_crypt_async_ =
      std::make_unique<os_crypt_async::OSCryptAsync>(std::move(providers));
}

void BrowserProcessImpl::CreateMetricsServiceClient() {
  metrics_service_client_ =
      std::make_unique<electron::ElectronMetricsServiceClient>();
}
