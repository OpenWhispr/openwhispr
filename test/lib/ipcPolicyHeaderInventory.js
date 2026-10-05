const { parse } = require("espree");

const POLICY_HEADER_BUILDERS = new Set(["withPolicyHeaders", "withPolicyRequestHeaders"]);

function walkSyntaxTree(value, visit) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => walkSyntaxTree(item, visit));
    return;
  }
  if (typeof value.type === "string") visit(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === "loc" || key === "range") continue;
    walkSyntaxTree(child, visit);
  }
}

function templateRoute(argument) {
  if (argument?.type !== "TemplateLiteral" || !isApiUrlExpression(argument.expressions[0])) {
    return null;
  }

  const routePrefix = argument.quasis[1]?.value.cooked;
  if (!routePrefix?.startsWith("/api/")) return null;

  let route = routePrefix.slice("/api/".length);
  for (let index = 1; index < argument.expressions.length; index += 1) {
    const expression = argument.expressions[index];
    const label = expression.type === "Identifier" ? expression.name : "dynamic";
    route += `\${${label}}${argument.quasis[index + 1]?.value.cooked ?? ""}`;
  }
  return route;
}

function isApiUrlExpression(expression) {
  if (expression?.type === "Identifier") return expression.name === "apiUrl";
  if (expression?.type !== "MemberExpression") return false;
  if (!expression.computed && expression.property?.type === "Identifier") {
    return expression.property.name === "apiUrl";
  }
  return expression.property?.type === "Literal" && expression.property.value === "apiUrl";
}

function containsPolicyHeaderBuilder(value) {
  let found = false;
  walkSyntaxTree(value, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      POLICY_HEADER_BUILDERS.has(node.callee.name)
    ) {
      found = true;
    }
  });
  return found;
}

function hasPolicyHeaders(options) {
  if (options?.type !== "ObjectExpression") return false;
  const headers = options.properties.find((property) => {
    if (property.type !== "Property") return false;
    if (!property.computed && property.key?.type === "Identifier") {
      return property.key.name === "headers";
    }
    return property.key?.type === "Literal" && property.key.value === "headers";
  });
  return containsPolicyHeaderBuilder(headers?.value);
}

function inspectDirectOpenWhisprApiCalls(source, fileName) {
  const syntaxTree = parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    loc: true,
  });
  const calls = [];
  walkSyntaxTree(syntaxTree, (node) => {
    if (
      node.type !== "CallExpression" ||
      node.callee?.type !== "Identifier" ||
      node.callee.name !== "proxyFetch"
    ) {
      return;
    }
    const route = templateRoute(node.arguments[0]);
    if (route === null) return;
    calls.push({
      fileName,
      line: node.loc.start.line,
      route,
      hasPolicyHeaders: hasPolicyHeaders(node.arguments[1]),
    });
  });
  return calls.sort((left, right) => left.line - right.line);
}

module.exports = { inspectDirectOpenWhisprApiCalls };
