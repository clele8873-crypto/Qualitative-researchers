import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { collection, addDoc, serverTimestamp, getDocs, query, orderBy, getDocFromServer, doc } from 'firebase/firestore';
import { db } from './firebase';
import { questions, dimensions, personalityTypes } from './data';
import { ChevronRight, ChevronLeft, Send, User, Hash, Lock, LogOut, X, AlertCircle } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Firestore Error Handling ---
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: any;
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: 'anonymous', // We are using password login, not Firebase Auth for admin
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// --- Error Display Component ---
function ErrorDisplay({ error, onRetry }: { error: string, onRetry: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-50 p-4">
      <div className="bg-white p-8 rounded-3xl shadow-sm border border-stone-200 max-w-md w-full text-center">
        <AlertCircle className="w-12 h-12 text-rose-500 mx-auto mb-4" />
        <h2 className="text-xl font-medium text-stone-900 mb-2">抱歉，出错了</h2>
        <p className="text-stone-600 mb-6">
          {error || "应用程序遇到了一个意外错误。请尝试刷新页面。"}
        </p>
        <button
          onClick={onRetry}
          className="px-6 py-2 bg-stone-800 text-white rounded-xl hover:bg-stone-900 transition-colors"
        >
          重试
        </button>
      </div>
    </div>
  );
}

type AppState = 'intro' | 'quiz' | 'result' | 'admin';

interface UserInfo {
  name: string;
  studentId: string;
}

export default function App() {
  const [appState, setAppState] = useState<AppState>('intro');
  const [userInfo, setUserInfo] = useState<UserInfo>({ name: '', studentId: '' });
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resultData, setResultData] = useState<any>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);

  // Admin state
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [adminResults, setAdminResults] = useState<any[]>([]);
  const [isLoadingAdmin, setIsLoadingAdmin] = useState(false);

  // Auto-save feature
  useEffect(() => {
    const savedData = localStorage.getItem('quiz_progress');
    if (savedData) {
      try {
        const { userInfo: savedUserInfo, answers: savedAnswers, currentQuestionIndex: savedIndex, appState: savedState } = JSON.parse(savedData);
        if (savedUserInfo) setUserInfo(savedUserInfo);
        if (savedAnswers) setAnswers(savedAnswers);
        if (typeof savedIndex === 'number') setCurrentQuestionIndex(savedIndex);
        // Only resume to quiz if they were in the middle of it
        if (savedState === 'quiz') setAppState('quiz');
      } catch (e) {
        console.error("Failed to load saved progress", e);
      }
    }
  }, []);

  useEffect(() => {
    if (appState === 'quiz' || (appState === 'intro' && (userInfo.name || userInfo.studentId))) {
      const dataToSave = {
        userInfo,
        answers,
        currentQuestionIndex,
        appState
      };
      localStorage.setItem('quiz_progress', JSON.stringify(dataToSave));
    }
  }, [userInfo, answers, currentQuestionIndex, appState]);

  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
        console.log("Firestore connection test successful");
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration. The client is offline.");
        }
      }
    }
    testConnection();
  }, []);

  const handleAdminLogin = (e: React.FormEvent) => {
    e.preventDefault();
    const correctPassword = process.env.VITE_ADMIN_PASSWORD || 'admin123';
    if (adminPassword === correctPassword) {
      setAppState('admin');
      setShowPasswordModal(false);
      loadAdminData();
    } else {
      alert("密码错误！");
    }
  };

  const handleResetProgress = () => {
    if (window.confirm("确定要清除所有进度并重新开始吗？")) {
      localStorage.removeItem('quiz_progress');
      setUserInfo({ name: '', studentId: '' });
      setAnswers({});
      setCurrentQuestionIndex(0);
      setAppState('intro');
    }
  };

  const handleAdminLogout = () => {
    setAppState('intro');
    setAdminPassword('');
  };

  const handleStart = (e: React.FormEvent) => {
    e.preventDefault();
    if (userInfo.name.trim() && userInfo.studentId.trim()) {
      setAppState('quiz');
    }
  };

  const handleAnswer = (value: number) => {
    setAnswers(prev => ({ ...prev, [questions[currentQuestionIndex].id]: value }));
    if (currentQuestionIndex < questions.length - 1) {
      setTimeout(() => {
        setCurrentQuestionIndex(prev => prev + 1);
      }, 300);
    }
  };

  const calculateResults = () => {
    const scores: Record<string, number> = {
      newPositivism: 0,
      originalism: 0,
      constructivism: 0,
      criticalTheory: 0
    };

    // Generic calculation for all dimensions
    Object.entries(dimensions).forEach(([dimKey, dimConfig]) => {
      dimConfig.questions.forEach((q: any) => {
        const qId = typeof q === 'number' ? q : q.id;
        const isReverse = typeof q === 'object' && q.reverse;
        const answer = answers[qId] || 0;
        
        if (answer === 0) return; // Should not happen if all questions are answered

        if (isReverse) {
          scores[dimKey] += (6 - answer);
        } else {
          scores[dimKey] += answer;
        }
      });
    });

    // Find highest score(s)
    let maxScore = -1;
    let topTypes: string[] = [];

    Object.entries(scores).forEach(([key, score]) => {
      if (score > maxScore) {
        maxScore = score;
        topTypes = [key];
      } else if (score === maxScore) {
        topTypes.push(key);
      }
    });

    return { scores, topTypes };
  };

  const handleSubmit = async () => {
    if (Object.keys(answers).length < questions.length) {
      alert("请回答所有问题后再提交！");
      return;
    }

    setIsSubmitting(true);
    
    // Set a timeout to prevent hanging
    const timeoutId = setTimeout(() => {
      if (isSubmitting) {
        setIsSubmitting(false);
        setGlobalError("提交超时，请检查网络连接或重试。");
      }
    }, 10000); // 10 seconds timeout

    try {
      const { scores, topTypes } = calculateResults();
      
      const resultPayload = {
        name: userInfo.name,
        studentId: userInfo.studentId,
        scores,
        resultTypes: topTypes,
        createdAt: serverTimestamp(),
      };

      await addDoc(collection(db, 'test_results'), resultPayload);
      clearTimeout(timeoutId);
      console.log("Result submitted successfully");
      
      // Clear saved progress on successful submission
      localStorage.removeItem('quiz_progress');
      
      setResultData({ scores, topTypes });
      setAppState('result');
    } catch (error) {
      clearTimeout(timeoutId);
      console.error("Error submitting results:", error);
      setGlobalError("提交失败，请检查网络连接或重试。");
    } finally {
      setIsSubmitting(false);
    }
  };

  const loadAdminData = async () => {
    setIsLoadingAdmin(true);
    try {
      const q = query(collection(db, 'test_results'), orderBy('createdAt', 'desc'));
      const querySnapshot = await getDocs(q);
      const results: any[] = [];
      querySnapshot.forEach((doc) => {
        results.push({ id: doc.id, ...doc.data() });
      });
      setAdminResults(results);
    } catch (error) {
      console.error("Error loading admin data:", error);
      setGlobalError("获取数据失败。");
    } finally {
      setIsLoadingAdmin(false);
    }
  };

  if (globalError) {
    return <ErrorDisplay error={globalError} onRetry={() => setGlobalError(null)} />;
  }

  return (
    <div className="min-h-screen bg-[#f5f5f0] text-stone-800 font-sans selection:bg-stone-300">
      <header className="p-4 flex justify-end">
        {appState !== 'admin' && (
          <button 
            onClick={() => setShowPasswordModal(true)}
            className="text-stone-400 hover:text-stone-600 transition-colors flex items-center gap-2 text-sm"
          >
            <Lock className="w-4 h-4" />
            <span>管理员</span>
          </button>
        )}
      </header>

      <AnimatePresence>
        {showPasswordModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-stone-900/40 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl"
            >
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-lg font-medium text-stone-900">管理员登录</h3>
                <button onClick={() => setShowPasswordModal(false)} className="text-stone-400 hover:text-stone-600">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <form onSubmit={handleAdminLogin} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">请输入管理密码</label>
                  <input
                    type="password"
                    autoFocus
                    value={adminPassword}
                    onChange={e => setAdminPassword(e.target.value)}
                    className="block w-full px-4 py-2 border border-stone-200 rounded-lg focus:ring-2 focus:ring-stone-400 focus:border-stone-400 bg-stone-50"
                    placeholder="密码"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full py-2 bg-stone-800 text-white rounded-lg hover:bg-stone-900 transition-colors font-medium"
                >
                  确认登录
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <main className="max-w-3xl mx-auto px-4 pb-20 pt-10">
        <AnimatePresence mode="wait">
          {appState === 'intro' && (
            <motion.div
              key="intro"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="bg-white rounded-3xl p-8 md:p-12 shadow-sm border border-stone-100"
            >
              <div className="text-center mb-10">
                <h1 className="text-3xl md:text-4xl font-serif font-medium text-stone-900 mb-4">
                  质性研究者人格测试
                </h1>
                <p className="text-stone-500">
                  探索你在质性研究中的认识论倾向与研究者底色
                </p>
              </div>

              <form onSubmit={handleStart} className="space-y-6 max-w-md mx-auto">
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-2">姓名</label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <User className="h-5 w-5 text-stone-400" />
                    </div>
                    <input
                      type="text"
                      required
                      value={userInfo.name}
                      onChange={e => setUserInfo({ ...userInfo, name: e.target.value })}
                      className="block w-full pl-10 pr-3 py-3 border border-stone-200 rounded-xl focus:ring-2 focus:ring-stone-400 focus:border-stone-400 bg-stone-50 transition-all"
                      placeholder="请输入您的姓名"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-2">学号</label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Hash className="h-5 w-5 text-stone-400" />
                    </div>
                    <input
                      type="text"
                      required
                      value={userInfo.studentId}
                      onChange={e => setUserInfo({ ...userInfo, studentId: e.target.value })}
                      className="block w-full pl-10 pr-3 py-3 border border-stone-200 rounded-xl focus:ring-2 focus:ring-stone-400 focus:border-stone-400 bg-stone-50 transition-all"
                      placeholder="请输入您的学号"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-3 mt-8">
                  <button
                    type="submit"
                    className="w-full flex justify-center items-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-white bg-stone-800 hover:bg-stone-900 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-stone-900 transition-all font-medium"
                  >
                    开始测试
                    <ChevronRight className="ml-2 h-5 w-5" />
                  </button>
                  
                  {(userInfo.name || userInfo.studentId || Object.keys(answers).length > 0) && (
                    <button
                      type="button"
                      onClick={handleResetProgress}
                      className="w-full py-2 text-stone-400 hover:text-stone-600 transition-colors text-sm font-medium"
                    >
                      清除进度并重新开始
                    </button>
                  )}
                </div>
              </form>
            </motion.div>
          )}

          {appState === 'quiz' && (
            <motion.div
              key="quiz"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="bg-white rounded-3xl p-8 md:p-12 shadow-sm border border-stone-100"
            >
              <div className="mb-8">
                <div className="flex justify-between text-sm text-stone-500 mb-2 font-mono">
                  <span>Question {currentQuestionIndex + 1}</span>
                  <span>{questions.length}</span>
                </div>
                <div className="w-full bg-stone-100 rounded-full h-1.5">
                  <div
                    className="bg-stone-800 h-1.5 rounded-full transition-all duration-500 ease-out"
                    style={{ width: `${((currentQuestionIndex + 1) / questions.length) * 100}%` }}
                  ></div>
                </div>
              </div>

              <div className="min-h-[200px] flex flex-col justify-center mb-10">
                <h2 className="text-2xl md:text-3xl font-medium text-stone-900 leading-relaxed">
                  {questions[currentQuestionIndex].text}
                </h2>
              </div>

              <div className="space-y-3">
                {[
                  { value: 5, label: "很同意" },
                  { value: 4, label: "同意" },
                  { value: 3, label: "一般" },
                  { value: 2, label: "不同意" },
                  { value: 1, label: "很不同意" }
                ].map((option) => (
                  <button
                    key={option.value}
                    onClick={() => handleAnswer(option.value)}
                    className={cn(
                      "w-full text-left px-6 py-4 rounded-xl border transition-all duration-200 flex items-center justify-between group",
                      answers[questions[currentQuestionIndex].id] === option.value
                        ? "border-stone-800 bg-stone-800 text-white"
                        : "border-stone-200 hover:border-stone-400 hover:bg-stone-50 text-stone-700"
                    )}
                  >
                    <span className="font-medium">{option.label}</span>
                    <div className={cn(
                      "w-5 h-5 rounded-full border-2 flex items-center justify-center",
                      answers[questions[currentQuestionIndex].id] === option.value
                        ? "border-white"
                        : "border-stone-300 group-hover:border-stone-400"
                    )}>
                      {answers[questions[currentQuestionIndex].id] === option.value && (
                        <div className="w-2.5 h-2.5 bg-white rounded-full" />
                      )}
                    </div>
                  </button>
                ))}
              </div>

              <div className="mt-10 flex justify-between items-center">
                <button
                  onClick={() => setCurrentQuestionIndex(prev => Math.max(0, prev - 1))}
                  disabled={currentQuestionIndex === 0}
                  className="flex items-center text-stone-500 hover:text-stone-800 disabled:opacity-30 disabled:hover:text-stone-500 transition-colors"
                >
                  <ChevronLeft className="w-5 h-5 mr-1" />
                  上一题
                </button>

                {currentQuestionIndex === questions.length - 1 ? (
                  <button
                    onClick={handleSubmit}
                    disabled={isSubmitting || Object.keys(answers).length < questions.length}
                    className="flex items-center px-6 py-2.5 bg-stone-800 text-white rounded-full hover:bg-stone-900 disabled:opacity-50 transition-all"
                  >
                    {isSubmitting ? "提交中..." : "查看结果"}
                    {!isSubmitting && <Send className="w-4 h-4 ml-2" />}
                  </button>
                ) : (
                  <button
                    onClick={() => setCurrentQuestionIndex(prev => Math.min(questions.length - 1, prev + 1))}
                    disabled={!answers[questions[currentQuestionIndex].id]}
                    className="flex items-center text-stone-500 hover:text-stone-800 disabled:opacity-30 disabled:hover:text-stone-500 transition-colors"
                  >
                    下一题
                    <ChevronRight className="w-5 h-5 ml-1" />
                  </button>
                )}
              </div>
            </motion.div>
          )}

          {appState === 'result' && resultData && (
            <motion.div
              key="result"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="space-y-6"
            >
              {resultData.topTypes.map((typeKey: keyof typeof personalityTypes) => {
                const typeInfo = personalityTypes[typeKey];
                return (
                  <div key={typeKey} className="bg-white rounded-3xl p-8 md:p-12 shadow-sm border border-stone-100 relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-64 h-64 bg-stone-50 rounded-full -mr-20 -mt-20 opacity-50 pointer-events-none"></div>
                    
                    <div className="relative z-10">
                      <div className="text-sm font-mono text-stone-500 mb-4 uppercase tracking-widest">Your Result</div>
                      <h2 className="text-3xl md:text-4xl font-serif font-medium text-stone-900 mb-6 leading-tight">
                        {typeInfo.name}
                      </h2>
                      <div className="w-12 h-1 bg-stone-800 mb-8"></div>
                      <p className="text-stone-600 text-lg leading-relaxed mb-10">
                        {typeInfo.description}
                      </p>
                    </div>
                  </div>
                );
              })}

              <div className="bg-white rounded-3xl p-8 shadow-sm border border-stone-100">
                <h3 className="text-xl font-medium text-stone-900 mb-6">维度得分详情</h3>
                <div className="space-y-5">
                  {[
                    { key: 'originalism', label: '原本论', color: 'bg-amber-700' },
                    { key: 'newPositivism', label: '新实证论', color: 'bg-blue-700' },
                    { key: 'constructivism', label: '建构论', color: 'bg-emerald-700' },
                    { key: 'criticalTheory', label: '批判理论', color: 'bg-rose-700' },
                  ].map((dim) => {
                    const score = resultData.scores[dim.key];
                    const percentage = (score / 25) * 100;
                    return (
                      <div key={dim.key}>
                        <div className="flex justify-between text-sm mb-2">
                          <span className="font-medium text-stone-700">{dim.label}</span>
                          <span className="font-mono text-stone-500">{score} / 25</span>
                        </div>
                        <div className="w-full bg-stone-100 rounded-full h-2">
                          <div
                            className={cn("h-2 rounded-full transition-all duration-1000", dim.color)}
                            style={{ width: `${percentage}%` }}
                          ></div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="flex justify-center pt-4">
                <button
                  onClick={() => {
                    setAppState('intro');
                    setUserInfo({ name: '', studentId: '' });
                    setAnswers({});
                    setCurrentQuestionIndex(0);
                  }}
                  className="px-8 py-3 border border-stone-200 text-stone-600 rounded-full hover:bg-stone-50 transition-all font-medium"
                >
                  返回首页
                </button>
              </div>
            </motion.div>
          )}

          {appState === 'admin' && (
            <motion.div
              key="admin"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="bg-white rounded-3xl p-8 shadow-sm border border-stone-100"
            >
              <div className="flex justify-between items-center mb-8">
                <h2 className="text-2xl font-serif font-medium text-stone-900">测验数据管理</h2>
                <div className="flex gap-4">
                  <button 
                    onClick={() => setAppState('intro')}
                    className="text-stone-500 hover:text-stone-800 text-sm font-medium transition-colors"
                  >
                    返回首页
                  </button>
                  <button 
                    onClick={handleAdminLogout}
                    className="flex items-center text-rose-600 hover:text-rose-700 text-sm font-medium transition-colors"
                  >
                    <LogOut className="w-4 h-4 mr-1" />
                    退出登录
                  </button>
                </div>
              </div>

              {isLoadingAdmin ? (
                <div className="py-20 text-center text-stone-500">加载数据中...</div>
              ) : adminResults.length === 0 ? (
                <div className="py-20 text-center text-stone-500">暂无测验数据</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm text-stone-600">
                    <thead className="text-xs text-stone-500 uppercase bg-stone-50 border-b border-stone-200">
                      <tr>
                        <th className="px-6 py-4 font-medium">时间</th>
                        <th className="px-6 py-4 font-medium">姓名</th>
                        <th className="px-6 py-4 font-medium">学号</th>
                        <th className="px-6 py-4 font-medium">测验结果</th>
                        <th className="px-6 py-4 font-medium text-right">原本论</th>
                        <th className="px-6 py-4 font-medium text-right">新实证论</th>
                        <th className="px-6 py-4 font-medium text-right">建构论</th>
                        <th className="px-6 py-4 font-medium text-right">批判理论</th>
                      </tr>
                    </thead>
                    <tbody>
                      {adminResults.map((result) => (
                        <tr key={result.id} className="border-b border-stone-100 hover:bg-stone-50/50 transition-colors">
                          <td className="px-6 py-4 whitespace-nowrap font-mono text-xs">
                            {result.createdAt?.toDate ? new Date(result.createdAt.toDate()).toLocaleString() : 'N/A'}
                          </td>
                          <td className="px-6 py-4 font-medium text-stone-900">{result.name}</td>
                          <td className="px-6 py-4 font-mono">{result.studentId}</td>
                          <td className="px-6 py-4">
                            <div className="flex flex-wrap gap-1">
                              {result.resultTypes.map((type: string) => (
                                <span key={type} className="inline-block px-2 py-1 bg-stone-100 text-stone-700 rounded text-xs">
                                  {personalityTypes[type as keyof typeof personalityTypes]?.name.split('·')[0].trim()}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-6 py-4 text-right font-mono">{result.scores.originalism}</td>
                          <td className="px-6 py-4 text-right font-mono">{result.scores.newPositivism}</td>
                          <td className="px-6 py-4 text-right font-mono">{result.scores.constructivism}</td>
                          <td className="px-6 py-4 text-right font-mono">{result.scores.criticalTheory}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
