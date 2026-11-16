#!/usr/bin/env ruby
# Regenerates EyeCapture.xcodeproj from the files in EyeCapture/.
#
# Run this after adding or removing a source file:
#
#   gem install xcodeproj
#   ruby generate_project.rb
#
# The generated project is committed, so you only need this when the file
# list changes.

require 'fileutils'
require 'xcodeproj'

Dir.chdir(__dir__)

NAME = 'EyeCapture'
PROJECT_PATH = "#{NAME}.xcodeproj"

FileUtils.rm_rf(PROJECT_PATH)
project = Xcodeproj::Project.new(PROJECT_PATH, false, 56)
project.root_object.compatibility_version = 'Xcode 14.0'
target = project.new_target(:application, NAME, :ios, '16.0', nil, :swift)

# new_target links Foundation through a path that names one exact SDK version.
# Swift links system frameworks by itself, so drop that reference.
target.frameworks_build_phase.files.to_a.each do |build_file|
  reference = build_file.file_ref
  target.frameworks_build_phase.remove_build_file(build_file)
  reference&.remove_from_project
end
project.frameworks_group.remove_from_project if project.frameworks_group.empty?

# Signing comes from Base.xcconfig, which includes the git-ignored
# Local.xcconfig if it exists. Settings on the target would override it, so
# the target sets none of those keys.
base_config = project.main_group.new_file('Base.xcconfig')
base_config.last_known_file_type = 'text.xcconfig'

group = project.new_group(NAME, NAME)
Dir["#{NAME}/*.swift"].sort.each do |path|
  target.source_build_phase.add_file_reference(group.new_file(File.basename(path)))
end
Dir["#{NAME}/*.html"].sort.each do |path|
  reference = group.new_file(File.basename(path))
  reference.last_known_file_type = 'text.html'
  target.resources_build_phase.add_file_reference(reference)
end

settings = {
  'PRODUCT_NAME' => '$(TARGET_NAME)',
  'MARKETING_VERSION' => '0.2.2',
  'CURRENT_PROJECT_VERSION' => '1',
  'SWIFT_VERSION' => '5.0',
  'IPHONEOS_DEPLOYMENT_TARGET' => '16.0',
  'TARGETED_DEVICE_FAMILY' => '1,2',
  'GENERATE_INFOPLIST_FILE' => 'YES',
  'INFOPLIST_KEY_CFBundleDisplayName' => 'Eye Capture',
  'INFOPLIST_KEY_NSCameraUsageDescription' =>
    'Records video of your eyes while you look at targets on another screen.',
  'INFOPLIST_KEY_NSLocalNetworkUsageDescription' =>
    'Lets your computer control the capture and download recordings over Wi-Fi.',
  'INFOPLIST_KEY_UIFileSharingEnabled' => 'YES',
  'INFOPLIST_KEY_LSSupportsOpeningDocumentsInPlace' => 'YES',
  'INFOPLIST_KEY_UIApplicationSceneManifest_Generation' => 'YES',
  'INFOPLIST_KEY_UILaunchScreen_Generation' => 'YES',
  'INFOPLIST_KEY_UISupportedInterfaceOrientations' =>
    'UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight',
  'INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad' =>
    'UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown ' \
    'UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight',
  'ENABLE_PREVIEWS' => 'NO',
}

target.build_configurations.each do |configuration|
  %w[INFOPLIST_FILE ASSETCATALOG_COMPILER_APPICON_NAME ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME].each do |key|
    configuration.build_settings.delete(key)
  end
  configuration.build_settings.merge!(settings)
  %w[PRODUCT_BUNDLE_IDENTIFIER DEVELOPMENT_TEAM CODE_SIGN_STYLE].each do |key|
    configuration.build_settings.delete(key)
  end
  configuration.base_configuration_reference = base_config
end

# Stable identifiers, so regenerating does not rewrite the whole file.
project.predictabilize_uuids
project.save
File.chmod(0o644, File.join(PROJECT_PATH, 'project.pbxproj'))

puts "Wrote #{PROJECT_PATH} with #{target.source_build_phase.files.count} source files."
