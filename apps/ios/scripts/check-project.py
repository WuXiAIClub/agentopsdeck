import json
import pathlib
import plistlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class ProjectConfigurationTests(unittest.TestCase):
    def test_plist_security_and_versioning(self):
        with (ROOT / "Resources/Info.plist").open("rb") as source:
            settings = plistlib.load(source)
        self.assertEqual(settings["NSAppTransportSecurity"], {"NSAllowsArbitraryLoads": True})
        self.assertTrue(settings["NSLocalNetworkUsageDescription"])
        self.assertEqual(settings["CFBundleIdentifier"], "$(PRODUCT_BUNDLE_IDENTIFIER)")
        self.assertEqual(settings["CFBundleVersion"], "$(CURRENT_PROJECT_VERSION)")
        self.assertIn("NSCameraUsageDescription", settings)
        self.assertIn("NSMicrophoneUsageDescription", settings)
        self.assertIn("NSPhotoLibraryAddUsageDescription", settings)
        self.assertNotIn("UIBackgroundModes", settings)
        self.assertFalse(settings["UIApplicationSceneManifest"]["UIApplicationSupportsMultipleScenes"])

    def test_privacy_manifest_covers_local_preferences_and_cleanup(self):
        with (ROOT / "Resources/PrivacyInfo.xcprivacy").open("rb") as source:
            privacy = plistlib.load(source)
        self.assertFalse(privacy["NSPrivacyTracking"])
        reasons = {item["NSPrivacyAccessedAPIType"]: item["NSPrivacyAccessedAPITypeReasons"]
                   for item in privacy["NSPrivacyAccessedAPITypes"]}
        self.assertIn("CA92.1", reasons["NSPrivacyAccessedAPICategoryUserDefaults"])
        self.assertIn("C617.1", reasons["NSPrivacyAccessedAPICategoryFileTimestamp"])

    def test_signing_is_replaceable_and_not_committed(self):
        settings = (ROOT / "Config/Client.xcconfig").read_text(encoding="utf-8")
        ignored = (ROOT / ".gitignore").read_text(encoding="utf-8")
        self.assertIn('#include? "Signing.local.xcconfig"', settings)
        self.assertIn("Config/Signing.local.xcconfig", ignored)
        self.assertIn("*.p12", ignored)
        self.assertIn("*.mobileprovision", ignored)

    def test_no_environment_specific_endpoint_is_shipped(self):
        for directory in ("Sources", "Config", "Resources"):
            for path in (ROOT / directory).rglob("*"):
                if path.suffix not in (".swift", ".plist", ".xcconfig", ".json", ".js"):
                    continue
                if path.name == "Signing.local.xcconfig":
                    continue
                content = path.read_text(encoding="utf-8")
                self.assertNotIn("deck.example.invalid", content, str(path))
                self.assertNotIn("192.168.", content, str(path))
                self.assertNotIn("AOD_ACCESS_KEY", content, str(path))

    def test_icon_manifest_has_existing_image(self):
        folder = ROOT / "Resources/Assets.xcassets/AppIcon.appiconset"
        manifest = json.loads((folder / "Contents.json").read_text(encoding="utf-8"))
        for image in manifest["images"]:
            self.assertTrue((folder / image["filename"]).is_file())
            self.assertEqual(image["size"], "1024x1024")

    def test_xcodegen_sources_and_tests_are_present(self):
        project = (ROOT / "project.yml").read_text(encoding="utf-8")
        self.assertIn("Resources/Assets.xcassets", project)
        self.assertIn("AgentOpsDeckTests:", project)
        self.assertIn("Resources/ResourceRouting.js", project)
        self.assertTrue((ROOT / "Resources/ResourceRouting.js").is_file())
        self.assertIn("- AgentOpsDeckTests", project)
        self.assertTrue((ROOT / "Tests/EndpointTests.swift").is_file())
        self.assertTrue((ROOT / "Tests/DownloadFileNameTests.swift").is_file())

    def test_local_network_security_boundaries(self):
        source = (ROOT / "Sources/WebViewController.swift").read_text(encoding="utf-8")
        rules = (ROOT / "Sources/ResourceAddress.swift").read_text(encoding="utf-8")
        probe = (ROOT / "Sources/ConnectionRouter.swift").read_text(encoding="utf-8")
        self.assertIn("compileContentRuleList", source)
        self.assertIn("userContentController.add(rules)", source)
        self.assertIn('"url-filter": "^http://"', rules)
        self.assertIn('"type": "block"', rules)
        self.assertIn('endpoint.url.scheme == "http"', rules)
        self.assertIn("configuration.httpCookieStorage = nil", probe)
        self.assertIn("configuration.urlCredentialStorage = nil", probe)
        self.assertIn("configuration.allowsCellularAccess = false", probe)
        self.assertIn("completionHandler(nil)", probe)
        self.assertNotIn("serverTrust", source + probe)


if __name__ == "__main__":
    unittest.main(verbosity=2)
