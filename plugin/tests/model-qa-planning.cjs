// Format/parser/schema choices belong to the operator. Merely mentioning
// JSON in an error-handling row is not the configuration format decision.
function ownerSubject(subject) {
  return /\b(file|config|configuration|settings?)\b.*\b(format|type|syntax|schema|shape)\b/i.test(subject)
    || (/\b(json|yaml|yml|toml|ini)\b/i.test(subject) && /format|syntax|parser|depend|shape/i.test(subject))
    || /(data|schema) shape|parser (library|dependency)|external dependency/i.test(subject);
}
module.exports = { ownerSubject };
