import React, { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Copy, Check, Home } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  componentStack: string;
  copied: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      componentStack: '',
      copied: false,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an unhandled error:', error, errorInfo);
    this.setState({ componentStack: errorInfo.componentStack || '' });
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    try {
      sessionStorage.clear();
    } catch {
      /* ignore */
    }
    this.setState({ hasError: false, error: null, componentStack: '', copied: false });
    window.location.href = window.location.pathname;
  };

  handleCopy = () => {
    const errorDetails = [
      `Tomato Reader 崩溃错误日志`,
      `时间: ${new Date().toLocaleString()}`,
      `错误信息: ${this.state.error?.message || '未知错误'}`,
      `错误堆栈:\n${this.state.error?.stack || '无'}\n`,
      `组件调用栈:\n${this.state.componentStack || '无'}`,
    ].join('\n');

    if (navigator.clipboard) {
      void navigator.clipboard.writeText(errorDetails).then(() => {
        this.setState({ copied: true });
        setTimeout(() => this.setState({ copied: false }), 2000);
      });
    }
  };

  override render() {
    if (this.state.hasError) {
      return (
        <div className="crash-screen" role="alert">
          <div className="crash-card">
            <div className="crash-header">
              <div className="crash-icon-box">
                <AlertTriangle size={36} className="crash-icon" />
              </div>
              <h2>应用遇到意外错误</h2>
              <p className="crash-subtext">
                阅读器捕获到了一个未处理的界面渲染异常。您的本地书架数据和账号均未丢失。
              </p>
            </div>

            <div className="crash-details-box">
              <div className="crash-error-title">
                {this.state.error?.name || 'Error'}: {this.state.error?.message || '未知异常'}
              </div>
              <pre className="crash-stack">
                {this.state.error?.stack || this.state.componentStack || '没有更多调试信息'}
              </pre>
            </div>

            <div className="crash-actions">
              <button type="button" className="crash-btn-primary" onClick={this.handleReload}>
                <RefreshCw size={15} />
                <span>重新载入应用</span>
              </button>

              <button type="button" className="crash-btn-secondary" onClick={this.handleCopy}>
                {this.state.copied ? <Check size={15} /> : <Copy size={15} />}
                <span>{this.state.copied ? '已复制日志' : '复制错误日志'}</span>
              </button>

              <button type="button" className="crash-btn-outline" onClick={this.handleReset}>
                <Home size={15} />
                <span>返回书架首页</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
