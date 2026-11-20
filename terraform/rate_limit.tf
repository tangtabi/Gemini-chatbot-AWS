# DynamoDB table for Lambda rate limiting
resource "aws_dynamodb_table" "rate_limit" {
  name         = "gemini-chatbot-rate-limit"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "ip_window"

  attribute {
    name = "ip_window"
    type = "S"
  }

  # Automatically expire old rate-limit counters
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  tags = {
    Project = "GeminiChatbot"
    Purpose = "RateLimiting"
  }
}
# Allow Lambda to read and update rate-limit counters
resource "aws_iam_role_policy" "rate_limit_access" {
  name = "gemini-chatbot-rate-limit-access"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:UpdateItem"
      ]
      Resource = aws_dynamodb_table.rate_limit.arn
    }]
  })
}