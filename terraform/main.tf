
terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
provider "aws" {
  region = "eu-north-1"
}
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}
variable "gemini_secret_arn" {
  description = "ARN of the Gemini API key in Secrets Manager"
  type        = string
}

# Lambda execution role
resource "aws_iam_role" "lambda_role" {
  name = "gemini-chatbot-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

# Permission to write Lambda logs
resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Permission to retrieve only your Gemini secret
resource "aws_iam_role_policy" "secret_access" {
  name = "gemini-secret-access"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = var.gemini_secret_arn
    }]
  })
}

# Lambda logs
resource "aws_cloudwatch_log_group" "lambda_logs" {
  name              = "/aws/lambda/gemini-chatbot"
  retention_in_days = 7
}

# Chatbot backend
resource "aws_lambda_function" "chatbot" {
  function_name    = "gemini-chatbot"
  role             = aws_iam_role.lambda_role.arn
  runtime          = "nodejs24.x"
  handler          = "src/server.handler"
  filename         = "${path.module}/../lambda-function.zip"
  source_code_hash = filebase64sha256("${path.module}/../lambda-function.zip")

  memory_size = 512
  timeout     = 30

  environment {
    variables = {
      NODE_ENV         = "production"
      GEMINI_SECRET_ID = var.gemini_secret_arn
      GEMINI_MODEL     = "gemini-3.5-flash-lite"
      RATE_LIMIT_TABLE = aws_dynamodb_table.rate_limit.name
    }
  }

  depends_on = [
  aws_iam_role_policy_attachment.lambda_logs,
  aws_iam_role_policy.secret_access,
  aws_iam_role_policy.rate_limit_access,
  aws_cloudwatch_log_group.lambda_logs
]
}

# API Gateway
resource "aws_apigatewayv2_api" "chat_api" {
  name          = "gemini-chatbot-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "lambda_integration" {
  api_id                 = aws_apigatewayv2_api.chat_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.chatbot.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "chat_route" {
  api_id    = aws_apigatewayv2_api.chat_api.id
  route_key = "POST /chat"
  target    = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

resource "aws_apigatewayv2_route" "health_route" {
  api_id    = aws_apigatewayv2_api.chat_api.id
  route_key = "GET /health"
  target    = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.chat_api.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 10
    throttling_rate_limit  = 5
  }
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.chatbot.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.chat_api.execution_arn}/*/*"
}

output "api_endpoint" {
  description = "Chatbot API endpoint"
  value       = aws_apigatewayv2_api.chat_api.api_endpoint
}
