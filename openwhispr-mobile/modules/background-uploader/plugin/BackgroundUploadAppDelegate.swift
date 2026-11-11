  // MARK: - Background upload recovery
  public override func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    // Expo waits for every subscriber, including ones that do not own this session.
    if BackgroundUploadRecovery.handleEvents(for: identifier, completionHandler: completionHandler) {
      return
    }
    super.application(
      application,
      handleEventsForBackgroundURLSession: identifier,
      completionHandler: completionHandler
    )
  }
