// app.js - الملف المركزي لمنصة البرمجة
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { 
    getFirestore, doc, getDoc, setDoc, updateDoc, collection, 
    query, where, getDocs, orderBy, limit, Timestamp, serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ==================== إعدادات Firebase ====================
const firebaseConfig = {
    apiKey: "AIzaSyBPgtF_GqT95QkMwwoJMGiZWFPjHFdA_N0",
    authDomain: "manassa-oloom.firebaseapp.com",
    projectId: "manassa-oloom",
    storageBucket: "manassa-oloom.firebasestorage.app",
    messagingSenderId: "475047988456",
    appId: "1:475047988456:web:ab25a9b01b5c77483b0d5d"
};

// ==================== تهيئة الخدمات ====================
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ==================== أنظمة التخزين المؤقت (Cache) ====================
// لحل مشكلة N+1 - تخزين الباقات والدروس محلياً بعد أول جلب
let packagesCache = new Map();     // تخزين الباقات { packageId: packageData }
let lessonsCache = new Map();      // تخزين الدروس { lessonId: lessonData }
let packagesByLessonCache = new Map(); // تخزين packageId لكل درس { lessonId: packageId }
let isCacheInitialized = false;
let cachePromise = null;

// ==================== دوال مساعدة عامة ====================

/**
 * عرض إشعار منبثق
 * @param {string} text - نص الإشعار
 * @param {boolean} isError - هل هو خطأ؟
 */
function showToast(text, isError = false) {
    // إزالة أي إشعار موجود مسبقاً
    const existingToast = document.querySelector('.toast-message');
    if (existingToast) existingToast.remove();
    
    const toast = document.createElement('div');
    toast.className = `toast-message ${isError ? 'error' : ''}`;
    toast.innerHTML = `<i class="fas ${isError ? 'fa-exclamation-triangle' : 'fa-check-circle'}"></i><span>${escapeHtml(text)}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

/**
 * التحقق من حالة الاتصال بالإنترنت
 * @returns {boolean}
 */
function checkOnlineStatus() {
    if (!navigator.onLine) {
        const banner = document.getElementById('offlineBanner');
        if (banner) banner.classList.add('show');
        return false;
    }
    const banner = document.getElementById('offlineBanner');
    if (banner) banner.classList.remove('show');
    return true;
}

/**
 * تنسيق النص لمنع هجمات XSS
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * تنسيق التاريخ من Timestamp Firebase
 * @param {Timestamp|Date|string} timestamp
 * @param {boolean} withTime - عرض الوقت أيضاً؟
 * @returns {string}
 */
function formatDate(timestamp, withTime = false) {
    if (!timestamp) return 'غير محدد';
    try {
        const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
        const options = { year: 'numeric', month: 'long', day: 'numeric' };
        if (withTime) {
            options.hour = '2-digit';
            options.minute = '2-digit';
        }
        return date.toLocaleDateString('ar-EG', options);
    } catch (e) {
        return 'غير محدد';
    }
}

/**
 * تنسيق الوقت بصيغة 12 ساعة
 * @param {string} timeStr - بصيغة HH:MM
 * @returns {string}
 */
function formatTime12(timeStr) {
    if (!timeStr) return '--:--';
    const [hours, minutes] = timeStr.split(':');
    let hour = parseInt(hours);
    const ampm = hour >= 12 ? 'مساءً' : 'صباحاً';
    hour = hour % 12 || 12;
    return `${hour}:${minutes} ${ampm}`;
}

/**
 * تنسيق التاريخ بصيغة YYYY-MM-DD
 * @param {Date} date
 * @returns {string}
 */
function formatDateYMD(date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

/**
 * الحصول على اسم اليوم بالعربية
 * @param {Date} date
 * @returns {string}
 */
function getArabicDay(date) {
    const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    return days[date.getDay()];
}

/**
 * استخراج ID فيديو يوتيوب من الرابط
 * @param {string} url
 * @returns {string|null}
 */
function getYouTubeId(url) {
    if (!url) return null;
    let videoId = null;
    if (url.includes('youtube.com/watch?v=')) {
        videoId = url.split('v=')[1]?.split('&')[0];
    } else if (url.includes('youtu.be/')) {
        videoId = url.split('/').pop();
    }
    return videoId;
}

// ==================== دوال التحقق من المستخدم ====================

/**
 * الحصول على وقت الخادم الحالي
 * @returns {Timestamp}
 */
function getServerTime() {
    return Timestamp.now();
}

/**
 * التحقق من وجود المستخدم وجلب بياناته
 * @returns {Promise<{uid: string, name: string, phone: string, activePackages: object, school: string}|null>}
 */
async function verifyUser() {
    return new Promise((resolve, reject) => {
        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            unsubscribe();
            
            if (!user) {
                reject(new Error('لا يوجد مستخدم مسجل الدخول'));
                return;
            }
            
            try {
                const userDoc = await getDoc(doc(db, 'STU_users', user.uid));
                if (!userDoc.exists()) {
                    await signOut(auth);
                    reject(new Error('بيانات المستخدم غير مكتملة'));
                    return;
                }
                
                const userData = userDoc.data();
                const userInfo = {
                    uid: user.uid,
                    name: userData.name || 'مستخدم',
                    phone: userData.phone || '',
                    activePackages: userData.activePackages || {},
                    school: userData.school || '',
                    email: userData.email || user.email
                };
                
                // تخزين في localStorage للاستخدام السريع
                localStorage.setItem('edu_user', JSON.stringify({
                    uid: userInfo.uid,
                    name: userInfo.name,
                    phone: userInfo.phone,
                    lastVerified: Date.now()
                }));
                
                resolve(userInfo);
            } catch (error) {
                console.error('خطأ في جلب بيانات المستخدم:', error);
                reject(error);
            }
        });
    });
}

/**
 * الحصول على المستخدم الحالي من localStorage (بدون طلب Firebase)
 * @returns {object|null}
 */
function getCurrentUserSync() {
    const stored = localStorage.getItem('edu_user');
    if (stored) {
        try {
            const user = JSON.parse(stored);
            if (user.lastVerified && (Date.now() - user.lastVerified) < 3600000) { // ساعة واحدة
                return user;
            }
        } catch (e) {}
    }
    return null;
}

/**
 * التحقق من صلاحية الاشتراك في باقة
 * @param {string} packageId
 * @param {object} activePackages - كائن activePackages من بيانات المستخدم
 * @returns {boolean}
 */
function isPackageActive(packageId, activePackages) {
    const subscription = activePackages?.[packageId];
    if (!subscription) return false;
    if (!subscription.expiresAt) return true;
    
    try {
        const serverTime = Timestamp.now();
        const expiryDate = subscription.expiresAt.toDate ? 
            subscription.expiresAt.toDate() : new Date(subscription.expiresAt);
        return expiryDate >= serverTime.toDate();
    } catch (e) {
        return true;
    }
}

// ==================== نظام التخزين المؤقت (Cache) لحل مشكلة N+1 ====================

/**
 * تهيئة نظام التخزين المؤقت - جلب جميع الباقات والدروس مرة واحدة
 * @param {boolean} force -强制执行 إعادة الجلب حتى لو كانت موجودة
 * @returns {Promise<void>}
 */
async function initCache(force = false) {
    if (isCacheInitialized && !force && cachePromise) {
        return cachePromise;
    }
    
    cachePromise = (async () => {
        try {
            console.log('🔄 جاري تهيئة نظام التخزين المؤقت...');
            
            // جلب جميع الباقات
            const packagesQuery = query(collection(db, 'PKG_packages'), orderBy('createdAt', 'desc'));
            const packagesSnap = await getDocs(packagesQuery);
            packagesCache.clear();
            packagesSnap.forEach(doc => {
                packagesCache.set(doc.id, { id: doc.id, ...doc.data() });
            });
            console.log(`✅ تم تحميل ${packagesCache.size} باقة`);
            
            // جلب جميع الدروس
            const lessonsQuery = query(collection(db, 'LESS_lessons'));
            const lessonsSnap = await getDocs(lessonsQuery);
            lessonsCache.clear();
            packagesByLessonCache.clear();
            lessonsSnap.forEach(doc => {
                const lessonData = { id: doc.id, ...doc.data() };
                lessonsCache.set(doc.id, lessonData);
                if (lessonData.packageId) {
                    packagesByLessonCache.set(doc.id, lessonData.packageId);
                }
            });
            console.log(`✅ تم تحميل ${lessonsCache.size} درس`);
            
            isCacheInitialized = true;
        } catch (error) {
            console.error('❌ فشل تهيئة التخزين المؤقت:', error);
            throw error;
        }
    })();
    
    return cachePromise;
}

/**
 * الحصول على بيانات باقة من التخزين المؤقت
 * @param {string} packageId
 * @returns {object|null}
 */
function getPackageFromCache(packageId) {
    return packagesCache.get(packageId) || null;
}

/**
 * الحصول على بيانات درس من التخزين المؤقت
 * @param {string} lessonId
 * @returns {object|null}
 */
function getLessonFromCache(lessonId) {
    return lessonsCache.get(lessonId) || null;
}

/**
 * الحصول على جميع الباقات من التخزين المؤقت
 * @returns {Array}
 */
function getAllPackagesFromCache() {
    return Array.from(packagesCache.values());
}

/**
 * الحصول على جميع الدروس من التخزين المؤقت
 * @returns {Array}
 */
function getAllLessonsFromCache() {
    return Array.from(lessonsCache.values());
}

/**
 * الحصول على دروس باقة معينة من التخزين المؤقت
 * @param {string} packageId
 * @returns {Array}
 */
function getLessonsByPackageFromCache(packageId) {
    const lessons = [];
    for (const lesson of lessonsCache.values()) {
        if (lesson.packageId === packageId) {
            lessons.push(lesson);
        }
    }
    return lessons.sort((a, b) => (a.lessonNumber || 0) - (b.lessonNumber || 0));
}

/**
 * البحث عن مستخدم برقم الهاتف (للتسجيل/الدخول)
 * @param {string} phone
 * @returns {Promise<object|null>}
 */
async function findUserByPhone(phone) {
    try {
        const usersRef = collection(db, 'STU_users');
        const q = query(usersRef, where('phone', '==', phone));
        const querySnapshot = await getDocs(q);
        
        if (!querySnapshot.empty) {
            const userDoc = querySnapshot.docs[0];
            return { id: userDoc.id, ...userDoc.data() };
        }
        return null;
    } catch (error) {
        console.error('خطأ في البحث عن المستخدم:', error);
        return null;
    }
}

// ==================== دوال التقدم (Progress) ====================

/**
 * حفظ تقدم المستخدم في باقة معينة
 * @param {string} userId
 * @param {string} packageId
 * @param {object} progressData - بيانات التقدم الجديدة
 * @param {boolean} merge - دمج مع البيانات الموجودة
 * @returns {Promise<void>}
 */
async function saveUserProgress(userId, packageId, progressData, merge = true) {
    const progressRef = doc(db, 'STU_users', userId, 'progress', packageId);
    await setDoc(progressRef, { 
        progress: progressData, 
        updatedAt: serverTimestamp() 
    }, { merge: merge });
}

/**
 * جلب تقدم المستخدم في باقة معينة
 * @param {string} userId
 * @param {string} packageId
 * @returns {Promise<object>}
 */
async function loadUserProgress(userId, packageId) {
    const progressRef = doc(db, 'STU_users', userId, 'progress', packageId);
    const snap = await getDoc(progressRef);
    if (snap.exists()) {
        return snap.data().progress || {};
    }
    return {};
}

// ==================== تصدير الدوال والكائنات ====================
export {
    // Firebase instances
    app, auth, db,
    
    // Utility functions
    showToast, checkOnlineStatus, escapeHtml, formatDate, formatTime12, formatDateYMD,
    getArabicDay, getYouTubeId, getServerTime,
    
    // User functions
    verifyUser, getCurrentUserSync, isPackageActive, findUserByPhone,
    
    // Cache functions (لحل مشكلة N+1)
    initCache, getPackageFromCache, getLessonFromCache, getAllPackagesFromCache,
    getAllLessonsFromCache, getLessonsByPackageFromCache,
    
    // Progress functions
    saveUserProgress, loadUserProgress,
    
    // Firestore helpers
    Timestamp, serverTimestamp, doc, getDoc, setDoc, updateDoc, collection,
    query, where, getDocs, orderBy, limit
};