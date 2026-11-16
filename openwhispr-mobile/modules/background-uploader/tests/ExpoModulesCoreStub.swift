// Only the Expo registration/Promise boundary is replaced. The tests compile the
// complete uploader and exercise its real app delegate, session and result handling.
import Foundation
import UIKit

// Real UIKit dispatch with a deliberately non-completing Expo subscriber route.
// Owned sessions must bypass this route; other sessions must still reach it.
open class ExpoAppDelegate: UIResponder, UIApplicationDelegate {
  public static var backgroundCallbacks: [(identifier: String, completion: () -> Void)] = []

  open func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    Self.backgroundCallbacks.append((identifier, completionHandler))
  }
}

public protocol Record {}

@propertyWrapper
public struct Field<Value> {
  public var wrappedValue: Value
  public init(wrappedValue: Value) { self.wrappedValue = wrappedValue }
  public init() where Value: ExpressibleByNilLiteral { wrappedValue = nil }
}

public struct TestDefinition {
  public let onCreate: (() -> Void)?
}

public typealias ModuleDefinition = [TestDefinition]

@resultBuilder
public enum ModuleDefinitionBuilder {
  public static func buildBlock(_ definitions: TestDefinition...) -> ModuleDefinition {
    definitions
  }
}

public protocol AnyModule {
  @ModuleDefinitionBuilder func definition() -> ModuleDefinition
}

open class BaseModule {
  public init() {}
}

public typealias Module = BaseModule & AnyModule

public func Name(_ name: String) -> TestDefinition { TestDefinition(onCreate: nil) }
public func OnCreate(_ body: @escaping () -> Void) -> TestDefinition {
  TestDefinition(onCreate: body)
}
public func AsyncFunction<Argument>(
  _ name: String, _ body: @escaping (Argument, Promise) -> Void
) -> TestDefinition { TestDefinition(onCreate: nil) }
public func Function<Result>(
  _ name: String, _ body: @escaping () throws -> Result
) -> TestDefinition { TestDefinition(onCreate: nil) }
public func Function<Argument, Result>(
  _ name: String, _ body: @escaping (Argument) throws -> Result
) -> TestDefinition { TestDefinition(onCreate: nil) }

public final class Promise {
  private let resolveBody: (Any?) -> Void
  private let rejectBody: (String, String) -> Void

  public init(resolve: @escaping (Any?) -> Void, reject: @escaping (String, String) -> Void) {
    resolveBody = resolve
    rejectBody = reject
  }

  public func resolve(_ value: Any?) { resolveBody(value) }
  public func reject(_ code: String, _ message: String) { rejectBody(code, message) }
}
